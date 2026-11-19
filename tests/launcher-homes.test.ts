import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'fs/promises'
import { basename, join } from 'path'
import { tmpdir } from 'os'

import { collectLauncherNotes, isNestedLauncherCodexHome, omnigentCodexHomes } from '../src/launcher-homes.js'
import { collectDoctorReport, renderDoctorTable } from '../src/doctor.js'
import { createCodexProvider } from '../src/providers/codex.js'
import { emptyCache } from '../src/session-cache.js'
import { setHome } from './setup/home.js'

function sessionMeta(sessionId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-04-14T10:00:00Z',
    payload: { cwd: '/Users/test/proj', originator: 'codex-cli', session_id: sessionId, model: 'gpt-5.3-codex', ...extra },
  })
}

/** Production Codex session_meta first lines are ~22–27 KB. */
function longSessionMeta(sessionId: string): string {
  return sessionMeta(sessionId, { base_instructions: 'x'.repeat(30 * 1024) })
}

async function writeCodexSession(codexDir: string, name: string, sessionId?: string, meta?: string): Promise<void> {
  const id = sessionId ?? name.replace(/^rollout-/, '').replace(/\.jsonl$/, '')
  const dayDir = join(codexDir, 'sessions', '2026', '04', '14')
  await mkdir(dayDir, { recursive: true })
  await writeFile(join(dayDir, name), `${meta ?? sessionMeta(id)}\n`)
}

function names(sources: { path: string }[]): string[] {
  return sources.map(s => basename(s.path))
}

describe('isNestedLauncherCodexHome', () => {
  it('skips a Codex home under .buzz when a distinct primary home exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'launch-'))
    const primary = join(root, 'real-codex')
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await mkdir(primary, { recursive: true })
    await mkdir(nested, { recursive: true })
    expect(isNestedLauncherCodexHome(nested, { primaryDir: primary, launcherRoots: [buzz] })).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('does not skip the sole Codex home even if it sits under .buzz', async () => {
    const root = await mkdtemp(join(tmpdir(), 'launch-'))
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await mkdir(nested, { recursive: true })
    expect(isNestedLauncherCodexHome(nested, { primaryDir: nested, launcherRoots: [buzz] })).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  it('treats a realpath-equivalent nest as the same home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'launch-'))
    const primary = join(root, 'real-codex')
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await mkdir(primary, { recursive: true })
    await mkdir(buzz, { recursive: true })
    await symlink(primary, nested)
    expect(isNestedLauncherCodexHome(nested, { primaryDir: primary, launcherRoots: [buzz] })).toBe(false)
    await rm(root, { recursive: true, force: true })
  })
})

describe('Codex discover overlap-only nest filter', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'codex-buzz-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('keeps a distinct nest rollout on the second factory', async () => {
    const primary = join(root, 'primary')
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await writeCodexSession(primary, 'rollout-primary.jsonl')
    await writeCodexSession(nested, 'rollout-buzz.jsonl')
    const real = createCodexProvider(primary, { primaryDir: primary, launcherRoots: [buzz] })
    const nest = createCodexProvider(nested, { primaryDir: primary, launcherRoots: [buzz] })
    expect(names(await real.discoverSessions())).toEqual(['rollout-primary.jsonl'])
    expect(names(await nest.discoverSessions())).toEqual(['rollout-buzz.jsonl'])
  })

  it('filters only a nest rollout whose session id overlaps the primary tree', async () => {
    const primary = join(root, 'primary')
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await writeCodexSession(primary, 'rollout-shared.jsonl', 'sess-shared')
    await writeCodexSession(nested, 'rollout-renamed.jsonl', 'sess-shared')
    await writeCodexSession(nested, 'rollout-buzz-only.jsonl', 'sess-buzz')
    const nest = createCodexProvider(nested, { primaryDir: primary, launcherRoots: [buzz] })
    expect(names(await nest.discoverSessions())).toEqual(['rollout-buzz-only.jsonl'])
  })

  it('keeps a nest rollout whose basename collides but session id is unique', async () => {
    const primary = join(root, 'primary')
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await writeCodexSession(primary, 'rollout-shared.jsonl', 'sess-primary')
    await writeCodexSession(nested, 'rollout-shared.jsonl', 'sess-nest')
    const nest = createCodexProvider(nested, { primaryDir: primary, launcherRoots: [buzz] })
    expect(names(await nest.discoverSessions())).toEqual(['rollout-shared.jsonl'])
  })

  it('default factory with CODEX_HOME=nest and a stub ~/.codex still discovers the nest', async () => {
    const home = root
    const primary = join(home, '.codex')
    const nested = join(home, '.buzz', '.codex')
    await mkdir(primary, { recursive: true })
    await writeCodexSession(nested, 'rollout-buzz.jsonl')
    const prevHome = process.env.HOME
    const prevCodex = process.env.CODEX_HOME
    setHome(home)
    process.env.CODEX_HOME = nested
    try {
      const provider = createCodexProvider()
      expect(names(await provider.discoverSessions())).toEqual(['rollout-buzz.jsonl'])
      const roots = await provider.probeRoots!()
      expect(roots.map(r => r.path)).toEqual([
        join(primary, 'sessions'),
        join(primary, 'archived_sessions'),
        join(nested, 'sessions'),
        join(nested, 'archived_sessions'),
      ])
    } finally {
      if (prevHome === undefined) setHome(undefined)
      else setHome(prevHome)
      if (prevCodex === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prevCodex
    }
  })

  it('no-arg factory discovers billed + unique nest and drops overlapping nest ids', async () => {
    const home = root
    const primary = join(home, '.codex')
    const nested = join(home, '.buzz', '.codex')
    await writeCodexSession(primary, 'rollout-billed.jsonl', 'sess-shared')
    await writeCodexSession(primary, 'rollout-billed-only.jsonl', 'sess-billed')
    await writeCodexSession(nested, 'rollout-renamed.jsonl', 'sess-shared')
    await writeCodexSession(nested, 'rollout-buzz-only.jsonl', 'sess-buzz')
    const prevHome = process.env.HOME
    const prevCodex = process.env.CODEX_HOME
    setHome(home)
    process.env.CODEX_HOME = nested
    try {
      const provider = createCodexProvider()
      expect(names(await provider.discoverSessions()).sort()).toEqual([
        'rollout-billed-only.jsonl',
        'rollout-billed.jsonl',
        'rollout-buzz-only.jsonl',
      ])
    } finally {
      if (prevHome === undefined) setHome(undefined)
      else setHome(prevHome)
      if (prevCodex === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prevCodex
    }
  })

  it('exported codex singleton dedups nest ids against billed home', async () => {
    const home = root
    const primary = join(home, '.codex')
    const nested = join(home, '.buzz', '.codex')
    await writeCodexSession(primary, 'rollout-billed.jsonl', 'sess-shared')
    await writeCodexSession(nested, 'rollout-renamed.jsonl', 'sess-shared')
    await writeCodexSession(nested, 'rollout-buzz-only.jsonl', 'sess-buzz')
    const prevHome = process.env.HOME
    const prevCodex = process.env.CODEX_HOME
    setHome(home)
    process.env.CODEX_HOME = nested
    vi.resetModules()
    try {
      const { codex } = await import('../src/providers/codex.js')
      expect(names(await codex.discoverSessions()).sort()).toEqual([
        'rollout-billed.jsonl',
        'rollout-buzz-only.jsonl',
      ])
    } finally {
      if (prevHome === undefined) setHome(undefined)
      else setHome(prevHome)
      if (prevCodex === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prevCodex
    }
  })

  it('exported no-arg singleton dedups production-size session_meta first lines', async () => {
    const home = root
    const primary = join(home, '.codex')
    const nested = join(home, '.buzz', '.codex')
    const billedA = longSessionMeta('sess-A')
    const nestA = longSessionMeta('sess-A')
    const nestB = longSessionMeta('sess-B')
    expect(Buffer.byteLength(billedA, 'utf8')).toBeGreaterThan(8 * 1024)
    expect(Buffer.byteLength(nestA, 'utf8')).toBeGreaterThan(8 * 1024)
    expect(Buffer.byteLength(nestB, 'utf8')).toBeGreaterThan(8 * 1024)
    await writeCodexSession(primary, 'rollout-billed-A-long.jsonl', 'sess-A', billedA)
    await writeCodexSession(nested, 'rollout-nest-A-long.jsonl', 'sess-A', nestA)
    await writeCodexSession(nested, 'rollout-nest-B-long.jsonl', 'sess-B', nestB)
    const prevHome = process.env.HOME
    const prevCodex = process.env.CODEX_HOME
    setHome(home)
    process.env.CODEX_HOME = nested
    vi.resetModules()
    try {
      const { createCodexProvider: noArgFactory, codex } = await import('../src/providers/codex.js')
      expect(names(await noArgFactory().discoverSessions()).sort()).toEqual([
        'rollout-billed-A-long.jsonl',
        'rollout-nest-B-long.jsonl',
      ])
      expect(names(await codex.discoverSessions()).sort()).toEqual([
        'rollout-billed-A-long.jsonl',
        'rollout-nest-B-long.jsonl',
      ])
    } finally {
      if (prevHome === undefined) setHome(undefined)
      else setHome(prevHome)
      if (prevCodex === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prevCodex
    }
  })

  it('second factory on a realpath-equivalent nest emits no duplicate sources', async () => {
    const primary = join(root, 'primary')
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await writeCodexSession(primary, 'rollout-same-physical-tree.jsonl')
    await mkdir(buzz, { recursive: true })
    await symlink(primary, nested)
    const real = createCodexProvider(primary, { primaryDir: primary, launcherRoots: [buzz] })
    const nest = createCodexProvider(nested, { primaryDir: primary, launcherRoots: [buzz] })
    expect(names(await real.discoverSessions())).toEqual(['rollout-same-physical-tree.jsonl'])
    expect(await nest.discoverSessions()).toEqual([])
  })

  it('explicit nest path without second-factory opts uses default launcher roots', async () => {
    const home = root
    const primary = join(home, '.codex')
    const nested = join(home, '.buzz', '.codex')
    await writeCodexSession(primary, 'rollout-primary.jsonl', 'sess-shared')
    await writeCodexSession(nested, 'rollout-renamed.jsonl', 'sess-shared')
    await writeCodexSession(nested, 'rollout-buzz.jsonl', 'sess-buzz')
    const prevHome = process.env.HOME
    setHome(home)
    try {
      const provider = createCodexProvider(nested)
      expect(names(await provider.discoverSessions())).toEqual(['rollout-buzz.jsonl'])
    } finally {
      if (prevHome === undefined) setHome(undefined)
      else setHome(prevHome)
    }
  })
})

describe('Codex omnigent homes', () => {
  let root: string
  let primary: string
  let native: string
  let prevHome: string | undefined
  let prevCodex: string | undefined
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-omnigent-'))
    primary = join(root, '.codex')
    native = join(root, '.omnigent', 'codex-native')
    prevHome = process.env.HOME
    prevCodex = process.env.CODEX_HOME
    setHome(root)
    delete process.env.CODEX_HOME
  })
  afterEach(async () => {
    if (prevHome === undefined) setHome(undefined)
    else setHome(prevHome)
    if (prevCodex === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodex
    await rm(root, { recursive: true, force: true })
  })

  it('no-arg factory adds omnigent rollouts and roots', async () => {
    await writeCodexSession(primary, 'rollout-billed.jsonl', 'sess-billed')
    await writeCodexSession(join(native, 'a1', 'codex-home'), 'rollout-omni.jsonl', 'sess-omni')
    const provider = createCodexProvider()
    expect(names(await provider.discoverSessions()).sort()).toEqual(['rollout-billed.jsonl', 'rollout-omni.jsonl'])
    expect((await provider.probeRoots!()).map(r => r.path)).toEqual([
      join(primary, 'sessions'), join(primary, 'archived_sessions'),
      join(native, 'a1', 'codex-home', 'sessions'), join(native, 'a1', 'codex-home', 'archived_sessions'),
    ])
  })

  it('no omnigent dir leaves roots unchanged', async () => {
    await writeCodexSession(primary, 'rollout-billed.jsonl')
    const provider = createCodexProvider()
    expect((await provider.probeRoots!()).map(r => r.path)).toEqual([join(primary, 'sessions'), join(primary, 'archived_sessions')])
    expect(names(await provider.discoverSessions())).toEqual(['rollout-billed.jsonl'])
  })

  it('drops omnigent rollouts already in the billed home', async () => {
    await writeCodexSession(primary, 'rollout-billed.jsonl', 'sess-shared')
    await writeCodexSession(join(native, 'a1', 'codex-home'), 'rollout-copy.jsonl', 'sess-shared')
    expect(names(await createCodexProvider().discoverSessions())).toEqual(['rollout-billed.jsonl'])
  })

  it('keeps sibling subagent rollouts that share their parent session_id', async () => {
    await mkdir(primary, { recursive: true })
    const home = join(native, 'a1', 'codex-home')
    await writeCodexSession(home, 'rollout-child-1.jsonl', 'sess-parent', sessionMeta('sess-parent', { id: 'thread-child-1' }))
    await writeCodexSession(home, 'rollout-child-2.jsonl', 'sess-parent', sessionMeta('sess-parent', { id: 'thread-child-2' }))
    expect(names(await createCodexProvider().discoverSessions()).sort()).toEqual(['rollout-child-1.jsonl', 'rollout-child-2.jsonl'])
  })

  it('dedups the same session across two omnigent homes', async () => {
    await mkdir(primary, { recursive: true })
    await writeCodexSession(join(native, 'a1', 'codex-home'), 'rollout-first.jsonl', 'sess-x')
    await writeCodexSession(join(native, 'b2', 'codex-home'), 'rollout-second.jsonl', 'sess-x')
    expect(names(await createCodexProvider().discoverSessions())).toEqual(['rollout-first.jsonl'])
  })

  it('CODEX_HOME inside omnigent is not scanned twice', async () => {
    const omni = join(native, 'a1', 'codex-home')
    await mkdir(primary, { recursive: true })
    await writeCodexSession(omni, 'rollout-omni.jsonl', 'sess-omni')
    process.env.CODEX_HOME = omni
    const provider = createCodexProvider()
    expect(names(await provider.discoverSessions())).toEqual(['rollout-omni.jsonl'])
    expect((await provider.probeRoots!()).map(r => r.path)).toEqual([join(omni, 'sessions'), join(omni, 'archived_sessions')])
  })

  it('explicit dir factory ignores omnigent', async () => {
    await writeCodexSession(primary, 'rollout-billed.jsonl')
    await writeCodexSession(join(native, 'a1', 'codex-home'), 'rollout-omni.jsonl')
    expect(names(await createCodexProvider(primary).discoverSessions())).toEqual(['rollout-billed.jsonl'])
  })
})

describe('omnigentCodexHomes', () => {
  it('lists codex-home dirs that hold sessions, sorted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    const native = join(home, '.omnigent', 'codex-native')
    await writeCodexSession(join(native, 'bbb', 'codex-home'), 'rollout-b.jsonl')
    await mkdir(join(native, 'aaa', 'codex-home', 'archived_sessions'), { recursive: true })
    expect(omnigentCodexHomes(home)).toEqual([join(native, 'aaa', 'codex-home'), join(native, 'bbb', 'codex-home')])
    await rm(home, { recursive: true, force: true })
  })

  it('skips incomplete and unreadable entries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    const native = join(home, '.omnigent', 'codex-native')
    await mkdir(join(native, 'no-home'), { recursive: true })
    await mkdir(join(native, 'empty', 'codex-home'), { recursive: true })
    await writeFile(join(native, 'process-registry.json'), '{}')
    expect(omnigentCodexHomes(home)).toEqual([])
    expect(omnigentCodexHomes(join(home, 'missing'))).toEqual([])
    await rm(home, { recursive: true, force: true })
  })
})

describe('doctor launchers', () => {
  it('lists Buzz as a launcher with no session count', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    await mkdir(join(home, '.buzz'), { recursive: true })
    const notes = collectLauncherNotes(home)
    expect(notes).toEqual([expect.objectContaining({ name: 'buzz', billedVia: 'codex' })])
    expect(notes[0]!.verdict).toMatch(/LAUNCHER/)
    expect(notes[0]!.verdict).not.toMatch(/\d+\s+session/)

    const report = await collectDoctorReport('all', {
      providers: [createCodexProvider(join(home, 'empty-codex'))],
      cache: emptyCache(),
      launchers: notes,
    })
    expect(report.launchers).toEqual(notes)
    const table = renderDoctorTable(report, { color: false })
    expect(table).toContain('Launchers')
    expect(table).toContain('buzz')
    expect(table).toContain('billed via Codex')
    const buzzLine = table.split('\n').find(line => /^\s*buzz\s/.test(line))
    expect(buzzLine).toBeDefined()
    expect(buzzLine).not.toMatch(/\d+\s+session/)
    await rm(home, { recursive: true, force: true })
  })

  it('lists omnigent as a launcher when codex-native exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    await mkdir(join(home, '.omnigent', 'codex-native'), { recursive: true })
    const notes = collectLauncherNotes(home)
    expect(notes).toEqual([expect.objectContaining({ name: 'omnigent', billedVia: 'codex' })])
    expect(notes[0]!.verdict).toMatch(/LAUNCHER/)
    expect(notes[0]!.verdict).not.toMatch(/\d+\s+session/)

    const report = await collectDoctorReport('all', {
      providers: [createCodexProvider(join(home, 'empty-codex'))],
      cache: emptyCache(),
      launchers: notes,
    })
    const table = renderDoctorTable(report, { color: false })
    expect(table).toContain('omnigent')
    expect(table).toContain('billed via Codex')
    await rm(home, { recursive: true, force: true })
  })
})
