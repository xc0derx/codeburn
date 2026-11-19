import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { addRemote, mergeDevicePayloads, pullDevices, renderDevices, summarizeDeviceUsage, type DeviceUsage } from '../../src/sharing/host.js'
import type { MenubarPayload } from '../../src/menubar-json.js'

const clientMock = vi.hoisted(() => ({
  hello: vi.fn(),
  pair: vi.fn(),
  pairRequest: vi.fn(),
  fetchUsage: vi.fn(),
}))

vi.mock('../../src/sharing/client.js', () => clientMock)

describe('host device flow', () => {
  let dir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    dir = await mkdtemp(join(tmpdir(), 'cb-host-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('pairs, persists, pulls both devices, and combines', async () => {
    const remoteUsage = { current: { cost: 100, calls: 10, sessions: 2, inputTokens: 1000, outputTokens: 200 } }
    clientMock.hello.mockResolvedValue({ status: 200, json: { fingerprint: 'remote-fp', name: 'MacBook' } })
    clientMock.pair.mockResolvedValue({ status: 200, json: { token: 'remote-token' } })
    clientMock.fetchUsage.mockResolvedValue({ status: 200, json: remoteUsage })

    const device = await addRemote('127.0.0.1:7777', '123456', { defaultPort: 7777, dir })
    expect(device.name).toBe('MacBook')
    expect(device.token).toBeTruthy()

    const localUsage = { current: { cost: 50, calls: 5, sessions: 1, inputTokens: 500, outputTokens: 100 } }
    const results = await pullDevices(async () => localUsage, { period: 'month' }, 'Mac Studio', { dir })

    expect(results).toHaveLength(2)
    expect(results[0]!.local).toBe(true)
    expect(results[0]!.payload!.current!.cost).toBe(50)
    const remote = results.find((r) => !r.local)!
    expect(remote.name).toBe('MacBook')
    expect(remote.payload!.current!.cost).toBe(100)
    expect(clientMock.fetchUsage).toHaveBeenCalledWith(
      expect.objectContaining({ host: '127.0.0.1', port: 7777, expectedFingerprint: 'remote-fp' }),
      'remote-token',
      { period: 'month' },
    )

    const text = renderDevices(results)
    expect(text).toContain('Mac Studio (this Mac)')
    expect(text).toContain('MacBook')
    expect(text).toContain('Combined')
    expect(text).toContain('150') // combined cost 50 + 100
  })

  it('renders an unreachable device as an error without dropping the combined row', () => {
    const results: DeviceUsage[] = [
      { id: 'local', name: 'Mac Studio', local: true, payload: { current: { cost: 10, calls: 1, sessions: 1, inputTokens: 1, outputTokens: 1 } } },
      { id: 'remote-1', name: 'MacBook', local: false, error: 'connection refused' },
    ]
    const text = renderDevices(results)
    expect(text).toContain('connection refused')
    expect(text).toContain('Combined')
  })

  it('summarizes reachable devices and excludes error rows from combined totals', () => {
    const results: DeviceUsage[] = [
      {
        id: 'local',
        name: 'Mac Studio',
        local: true,
        payload: {
          current: { cost: 10, calls: 2, sessions: 1, inputTokens: 100, outputTokens: 40 },
          history: {
            daily: [
              { cacheWriteTokens: 5, cacheReadTokens: 10 },
              { cacheWriteTokens: 7, cacheReadTokens: 3 },
            ],
          },
        },
      },
      {
        id: 'remote-1',
        name: 'MacBook',
        local: false,
        payload: {
          current: { cost: 3, calls: 4, sessions: 2, inputTokens: 20, outputTokens: 30 },
          history: { daily: [{ cacheWriteTokens: 2, cacheReadTokens: 8 }] },
        },
      },
      { id: 'remote-err', name: 'Offline', local: false, error: 'timeout' },
    ]

    const summary = summarizeDeviceUsage(results)

    expect(summary.perDevice).toEqual([
      {
        id: 'local',
        name: 'Mac Studio',
        local: true,
        cost: 10,
        calls: 2,
        sessions: 1,
        inputTokens: 100,
        outputTokens: 40,
        cacheCreateTokens: 12,
        cacheReadTokens: 13,
        totalTokens: 165,
      },
      {
        id: 'remote-1',
        name: 'MacBook',
        local: false,
        cost: 3,
        calls: 4,
        sessions: 2,
        inputTokens: 20,
        outputTokens: 30,
        cacheCreateTokens: 2,
        cacheReadTokens: 8,
        totalTokens: 60,
      },
      {
        id: 'remote-err',
        name: 'Offline',
        local: false,
        error: 'timeout',
        cost: 0,
        calls: 0,
        sessions: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
      },
    ])
    expect(summary.combined).toEqual({
      cost: 13,
      calls: 6,
      sessions: 3,
      inputTokens: 120,
      outputTokens: 70,
      cacheCreateTokens: 14,
      cacheReadTokens: 21,
      totalTokens: 225,
      deviceCount: 3,
      reachableCount: 2,
    })
  })

  it('scopes cache-token summaries to the optional window without changing no-window totals', () => {
    const results: DeviceUsage[] = [
      {
        id: 'local',
        name: 'Mac Studio',
        local: true,
        payload: {
          current: { cost: 1, calls: 1, sessions: 1, inputTokens: 100, outputTokens: 50 },
          history: {
            daily: [
              { date: '2026-04-09', cacheWriteTokens: 100, cacheReadTokens: 1000 },
              { date: '2026-04-10', cacheWriteTokens: 5, cacheReadTokens: 10 },
              { date: '2026-04-11', cacheWriteTokens: 7, cacheReadTokens: 3 },
            ],
          },
        },
      },
      {
        id: 'remote-1',
        name: 'MacBook',
        local: false,
        payload: {
          current: { cost: 2, calls: 2, sessions: 1, inputTokens: 20, outputTokens: 30 },
          history: {
            daily: [
              { date: '2026-04-08', cacheWriteTokens: 11, cacheReadTokens: 13 },
              { date: '2026-04-10', cacheWriteTokens: 2, cacheReadTokens: 8 },
            ],
          },
        },
      },
    ]

    const all = summarizeDeviceUsage(results)
    expect(all.perDevice[0]).toMatchObject({
      cacheCreateTokens: 112,
      cacheReadTokens: 1013,
      totalTokens: 1275,
    })
    expect(all.perDevice[1]).toMatchObject({
      cacheCreateTokens: 13,
      cacheReadTokens: 21,
      totalTokens: 84,
    })
    expect(all.combined).toMatchObject({
      inputTokens: 120,
      outputTokens: 80,
      cacheCreateTokens: 125,
      cacheReadTokens: 1034,
      totalTokens: 1359,
    })

    const scoped = summarizeDeviceUsage(results, { start: '2026-04-10', end: '2026-04-10' })
    expect(scoped.perDevice[0]).toMatchObject({
      cacheCreateTokens: 5,
      cacheReadTokens: 10,
      totalTokens: 165,
    })
    expect(scoped.perDevice[1]).toMatchObject({
      cacheCreateTokens: 2,
      cacheReadTokens: 8,
      totalTokens: 60,
    })
    expect(scoped.combined).toMatchObject({
      cost: 3,
      calls: 3,
      sessions: 2,
      inputTokens: 120,
      outputTokens: 80,
      cacheCreateTokens: 7,
      cacheReadTokens: 18,
      totalTokens: 225,
      deviceCount: 2,
      reachableCount: 2,
    })
  })

  it('prefers period-scoped current cache tokens over the 365-day daily history (#583)', () => {
    const results: DeviceUsage[] = [
      {
        id: 'local',
        name: 'Mac',
        local: true,
        payload: {
          current: { cost: 1, calls: 1, sessions: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 42, cacheWriteTokens: 7 },
          history: {
            daily: [
              // A full 365-day backfill whose cache dwarfs the selected period.
              { date: '2025-08-01', cacheWriteTokens: 900, cacheReadTokens: 5000 },
              { date: '2026-04-10', cacheWriteTokens: 3, cacheReadTokens: 8 },
            ],
          },
        },
      },
    ]

    const summary = summarizeDeviceUsage(results)
    // Reads current (7 / 42), not the inflated daily-history sum (903 / 5008).
    expect(summary.perDevice[0]).toMatchObject({ cacheCreateTokens: 7, cacheReadTokens: 42 })
    expect(summary.combined).toMatchObject({ cacheCreateTokens: 7, cacheReadTokens: 42 })
  })

  it('groups thousands in the integer part of costs only', () => {
    const device = (id: string, cost: number): DeviceUsage => ({ id, name: id, local: id === 'a', payload: { current: { cost, calls: 1, sessions: 1, inputTokens: 1, outputTokens: 1 } } })
    const text = renderDevices([device('a', 0.0028), device('b', 1234567)])
    expect(text).toContain('$0.0028')
    expect(text).not.toContain('$0.0,028')
    expect(text).toContain('$1,234,567.00')
  })
})

describe('mergeDevicePayloads', () => {
  function devicePayload(current: Partial<MenubarPayload['current']>, daily: MenubarPayload['history']['daily'] = []): MenubarPayload {
    return {
      current: {
        label: 'Last 7 Days',
        cost: 0, calls: 0, sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitPercent: 0,
        topActivities: [], topModels: [], providers: {}, providerDetails: [], topProjects: [], topSessions: [],
        tools: [], skills: [], mcpServers: [], subagents: [],
        ...current,
      },
      history: { daily },
    } as unknown as MenubarPayload
  }
  const day = (date: string, cost: number, models: Array<[string, number]>) => ({
    date, cost, savingsUSD: 0, calls: 1, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    topModels: models.map(([name, c]) => ({ name, cost: c, savingsUSD: 0, calls: 1, inputTokens: 10, outputTokens: 1 })),
  })

  const local = devicePayload({
    cost: 0.36, calls: 70, sessions: 3, inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0, cacheHitPercent: 90,
    topActivities: [{ name: 'Coding', cost: 0.27, savingsUSD: 0, turns: 4, oneShotRate: 1 }],
    topModels: [{ name: 'GPT-6.1 Terra', cost: 0.34, savingsUSD: 0, savingsBaselineModel: '', calls: 51, inputTokens: 100 }],
    providers: { codex: 0.36 },
    providerDetails: [{ id: 'codex', label: 'Codex', cost: 0.36, calls: 70, hasUsage: true, inputTokens: 100 }],
    tools: [{ name: 'Bash', calls: 5 }],
    topProjects: [{ name: 'local-project' } as MenubarPayload['current']['topProjects'][number]],
  }, [day('2026-11-13', 0.36, [['GPT-6.1 Terra', 0.36]])])
  const remote = devicePayload({
    cost: 63.48, calls: 287, sessions: 9, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 100,
    topActivities: [
      { name: 'Coding', cost: 50, savingsUSD: 0, turns: 12, oneShotRate: 0.5 },
      { name: 'Debugging', cost: 13.48, savingsUSD: 0, turns: 3, oneShotRate: null },
    ],
    topModels: [
      { name: 'GPT-6.2 Sol', cost: 60, savingsUSD: 0, savingsBaselineModel: '', calls: 250 },
      { name: 'GPT-6.1 Terra', cost: 3.48, savingsUSD: 0, savingsBaselineModel: '', calls: 37 },
    ],
    providers: { codex: 63.48 },
    providerDetails: [{ id: 'codex', label: 'Codex', cost: 63.48, calls: 287, hasUsage: true }],
    tools: [{ name: 'Bash', calls: 40 }, { name: 'Read', calls: 7 }],
  }, [day('2026-11-13', 3, [['GPT-6.1 Terra', 3]]), day('2026-11-18', 60.48, [['GPT-6.2 Sol', 60.48]])])

  const results: DeviceUsage[] = [
    { id: 'local', name: 'Mac', local: true, payload: local },
    { id: 'fp', name: 'netcup-1', local: false, payload: remote },
    { id: 'off', name: 'offline', local: false, error: 'timeout' },
  ]

  it('folds reachable remote devices into totals and breakdowns', () => {
    const { current } = mergeDevicePayloads(local, results)

    expect(current.cost).toBeCloseTo(63.84)
    expect(current.calls).toBe(357)
    expect(current.cacheHitPercent).toBeCloseTo(9900 / (1100 + 9900 + 100) * 100)
    expect(current.topModels.map((m) => [m.name, m.calls])).toEqual([['GPT-6.2 Sol', 250], ['GPT-6.1 Terra', 88]])
    expect(current.topActivities.map((a) => a.name)).toEqual(['Coding', 'Debugging'])
    expect(current.topActivities[0]!.turns).toBe(16)
    expect(current.topActivities[0]!.oneShotRate).toBeCloseTo((1 * 4 + 0.5 * 12) / 16)
    expect(current.topActivities[1]!.oneShotRate).toBeNull()
    expect(Object.keys(current.providers)).toEqual(['codex'])
    expect(current.providers.codex).toBeCloseTo(63.84)
    expect(current.providerDetails).toHaveLength(1)
    expect(current.providerDetails[0]!.cost).toBeCloseTo(63.84)
    expect(current.tools).toEqual([{ name: 'Bash', calls: 45 }, { name: 'Read', calls: 7 }])
  })

  it('drops an optional count that not every device reported instead of under-reporting it', () => {
    const { current } = mergeDevicePayloads(local, results)
    expect(current.topModels.find((m) => m.name === 'GPT-6.1 Terra')!.inputTokens).toBeUndefined()
    expect(current.providerDetails[0]!.inputTokens).toBeUndefined()
  })

  it('keeps local-only rows and merges daily history by date', () => {
    const { current, history } = mergeDevicePayloads(local, results)
    expect(current.topProjects.map((p) => p.name)).toEqual(['local-project'])
    expect(current.label).toBe('Last 7 Days')
    expect(history.daily.map((d) => [d.date, d.cost])).toEqual([['2026-11-13', 3.36], ['2026-11-18', 60.48]])
    expect(history.daily[0]!.topModels).toEqual([
      { name: 'GPT-6.1 Terra', cost: 3.36, savingsUSD: 0, calls: 2, inputTokens: 20, outputTokens: 2 },
    ])
  })

  it('leaves a local-only result unchanged', () => {
    const { current, history } = mergeDevicePayloads(local, [results[0]!])
    expect(current).toEqual(local.current)
    expect(history).toEqual(local.history)
  })
})
