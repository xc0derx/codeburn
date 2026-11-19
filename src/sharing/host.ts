import { hello, pair, pairRequest, fetchUsage } from './client.js'
import { loadOrCreateIdentity } from './identity.js'
import { pairingCode } from './pairing.js'
import { sanitizeForSharing } from './sanitize.js'
import type { DiscoveredDevice } from './discovery.js'
import type { UsageQuery } from './share-server.js'
import { getSharingDir, loadRemotes, saveRemotes, type RemoteDevice } from './store.js'
import type { CombinedUsage, DeviceSummary, MenubarPayload } from '../menubar-json.js'
import { formatCost } from '../currency.js'
import { sessionCacheHitPercent } from '../sessions-report.js'
import { renderTable } from '../text-table.js'
import { Chalk } from 'chalk'

export type { CombinedUsage, DeviceSummary } from '../menubar-json.js'

// Minimal shape we read from a device's usage payload (the menubar payload).
// Cache read/write come from the period-scoped `current` (like input/output)
// when the peer sends them; older peers only carry cache in the daily history,
// so we fall back to summing that (scoped by `window` when provided).
type DevicePayload = {
  current?: { cost?: number; calls?: number; sessions?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  history?: { daily?: Array<{ date?: string; cacheReadTokens?: number; cacheWriteTokens?: number }> }
}

type SummaryWindow = {
  start: string
  end: string
}

export type DeviceUsage = {
  id: string // stable unique id (cert fingerprint for remotes, 'local' for this device)
  name: string
  local: boolean
  payload?: DevicePayload
  error?: string
}

const zeroUsage = {
  cost: 0,
  calls: 0,
  sessions: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
}

function num(n: number | undefined): number {
  return n ?? 0
}

function summarizeOneDevice(d: DeviceUsage, window?: SummaryWindow): DeviceSummary {
  const error = d.error !== undefined ? d.error : d.payload === undefined ? 'no usage payload' : undefined
  if (error !== undefined || d.payload === undefined) {
    return {
      id: d.id,
      name: d.name,
      local: d.local,
      error,
      ...zeroUsage,
    }
  }

  const cur = d.payload.current
  const daily = (d.payload.history?.daily ?? []).filter((e) => {
    if (window === undefined) return true
    return e.date !== undefined && window.start <= e.date && e.date <= window.end
  })
  const inputTokens = num(cur?.inputTokens)
  const outputTokens = num(cur?.outputTokens)
  // Prefer the period-scoped `current` counts (issue #583); fall back to the
  // windowed daily history for older peers that don't send them. `??` keeps a
  // genuine 0 and only falls back when the field is absent.
  const cacheCreateTokens = cur?.cacheWriteTokens ?? daily.reduce((s, e) => s + num(e.cacheWriteTokens), 0)
  const cacheReadTokens = cur?.cacheReadTokens ?? daily.reduce((s, e) => s + num(e.cacheReadTokens), 0)
  return {
    id: d.id,
    name: d.name,
    local: d.local,
    cost: num(cur?.cost),
    calls: num(cur?.calls),
    sessions: num(cur?.sessions),
    inputTokens,
    outputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens,
  }
}

export function summarizeDeviceUsage(results: DeviceUsage[], window?: SummaryWindow): CombinedUsage {
  const perDevice = results.map((d) => summarizeOneDevice(d, window))
  const combined = perDevice.reduce(
    (a, d) => {
      if (d.error !== undefined) return a
      return {
        cost: a.cost + d.cost,
        calls: a.calls + d.calls,
        // Numeric wire sum only. Combined-scope UI must not present this as a
        // unique or lower-bound session count until a cross-device identity
        // contract exists.
        sessions: a.sessions + d.sessions,
        inputTokens: a.inputTokens + d.inputTokens,
        outputTokens: a.outputTokens + d.outputTokens,
        cacheCreateTokens: a.cacheCreateTokens + d.cacheCreateTokens,
        cacheReadTokens: a.cacheReadTokens + d.cacheReadTokens,
        totalTokens: a.totalTokens + d.totalTokens,
        deviceCount: a.deviceCount,
        reachableCount: a.reachableCount + 1,
      }
    },
    { ...zeroUsage, deviceCount: perDevice.length, reachableCount: 0 },
  )
  return { perDevice, combined }
}

type Current = MenubarPayload['current']

// Sum an add-only optional field. Absent on any contributor means the merged
// value is unknown, so it stays absent rather than under-reporting.
function sumOptional<T>(rows: T[], get: (row: T) => number | undefined): number | undefined {
  let total = 0
  for (const row of rows) {
    const v = get(row)
    if (v === undefined) return undefined
    total += v
  }
  return total
}

// Group rows by key, keeping the cost-descending order every producer emits.
function mergeRows<T, K>(rows: T[], key: (row: T) => K, merge: (group: T[]) => T, cost: (row: T) => number): T[] {
  const groups = new Map<K, T[]>()
  for (const row of rows) {
    const k = key(row)
    const g = groups.get(k)
    if (g) g.push(row)
    else groups.set(k, [row])
  }
  return [...groups.values()].map(merge).sort((a, b) => cost(b) - cost(a))
}

// The breakdowns behind the combined headline: the local `current`/`history`
// with every reachable device's aggregate rows folded in. Project-, session-
// and branch-level rows stay local, since remote payloads are sanitized of them.
export function mergeDevicePayloads(local: MenubarPayload, results: DeviceUsage[]): Pick<MenubarPayload, 'current' | 'history'> {
  const payloads = [
    local,
    ...results.filter((d) => !d.local && d.error === undefined && d.payload !== undefined).map((d) => d.payload as unknown as MenubarPayload),
  ]
  const currents = payloads.map((p) => p.current ?? ({} as Partial<Current>))
  const all = <K extends keyof Current>(field: K): NonNullable<Current[K]> extends Array<infer R> ? R[] : never =>
    currents.flatMap((c) => (c[field] as unknown[] | undefined) ?? []) as never
  const sum = (field: 'cost' | 'calls' | 'sessions' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'): number =>
    currents.reduce((s, c) => s + num(c[field]), 0)

  const providers: Record<string, number> = {}
  for (const c of currents) {
    for (const [name, cost] of Object.entries(c.providers ?? {})) providers[name] = (providers[name] ?? 0) + num(cost)
  }

  const inputTokens = sum('inputTokens')
  const cacheReadTokens = sum('cacheReadTokens')
  const cacheWriteTokens = sum('cacheWriteTokens')
  const estimatedCostUSD = sumOptional(currents, (c) => c.estimatedCostUSD)
  const current: Current = {
    ...local.current,
    cost: sum('cost'),
    calls: sum('calls'),
    sessions: sum('sessions'),
    inputTokens,
    outputTokens: sum('outputTokens'),
    cacheReadTokens,
    cacheWriteTokens,
    cacheHitPercent: sessionCacheHitPercent(inputTokens, cacheReadTokens, cacheWriteTokens) ?? 0,
    ...(estimatedCostUSD !== undefined ? { estimatedCostUSD } : {}),
    topActivities: mergeRows(all('topActivities'), (a) => a.name, (g) => {
      // One-shot rate weighted by turns, ignoring devices that report none.
      const rated = g.filter((a) => a.oneShotRate !== null)
      const weight = rated.reduce((s, a) => s + Math.max(num(a.turns), 1), 0)
      return {
        ...g[0]!,
        cost: g.reduce((s, a) => s + num(a.cost), 0),
        savingsUSD: g.reduce((s, a) => s + num(a.savingsUSD), 0),
        turns: g.reduce((s, a) => s + num(a.turns), 0),
        oneShotRate: weight > 0 ? rated.reduce((s, a) => s + num(a.oneShotRate ?? 0) * Math.max(num(a.turns), 1), 0) / weight : null,
      }
    }, (a) => a.cost),
    topModels: mergeRows(all('topModels'), (m) => m.name, (g) => {
      const { estimatedCostUSD: _e, inputTokens: _i, outputTokens: _o, cacheReadTokens: _r, cacheWriteTokens: _w, ...first } = g[0]!
      const optional = {
        estimatedCostUSD: sumOptional(g, (m) => m.estimatedCostUSD),
        inputTokens: sumOptional(g, (m) => m.inputTokens),
        outputTokens: sumOptional(g, (m) => m.outputTokens),
        cacheReadTokens: sumOptional(g, (m) => m.cacheReadTokens),
        cacheWriteTokens: sumOptional(g, (m) => m.cacheWriteTokens),
      }
      return {
        ...first,
        savingsBaselineModel: g.find((m) => m.savingsBaselineModel)?.savingsBaselineModel ?? '',
        cost: g.reduce((s, m) => s + num(m.cost), 0),
        savingsUSD: g.reduce((s, m) => s + num(m.savingsUSD), 0),
        calls: g.reduce((s, m) => s + num(m.calls), 0),
        ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
      }
    }, (m) => m.cost),
    providers,
    providerDetails: mergeRows(all('providerDetails'), (p) => p.id, (g) => {
      // Per-provider token/session splits are only kept when every device sent them.
      const { inputTokens: _i, outputTokens: _o, sessions: _s, sessionCountBasis: _b, cacheReadTokens: _r, estimatedCostUSD: _e, ...first } = g[0]!
      const optional = {
        estimatedCostUSD: sumOptional(g, (p) => p.estimatedCostUSD),
        inputTokens: sumOptional(g, (p) => p.inputTokens),
        outputTokens: sumOptional(g, (p) => p.outputTokens),
        cacheReadTokens: sumOptional(g, (p) => p.cacheReadTokens),
      }
      return {
        ...first,
        cost: g.reduce((s, p) => s + num(p.cost), 0),
        calls: g.reduce((s, p) => s + num(p.calls), 0),
        hasUsage: g.some((p) => p.hasUsage),
        ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
      }
    }, (p) => p.cost),
    tools: mergeRows(all('tools'), (t) => t.name, (g) => ({ name: g[0]!.name, calls: g.reduce((s, t) => s + num(t.calls), 0) }), (t) => t.calls),
    skills: mergeRows(all('skills'), (k) => k.name, (g) => ({
      name: g[0]!.name,
      turns: g.reduce((s, k) => s + num(k.turns), 0),
      cost: g.reduce((s, k) => s + num(k.cost), 0),
    }), (k) => k.cost),
    mcpServers: mergeRows(all('mcpServers'), (m) => m.name, (g) => ({ name: g[0]!.name, calls: g.reduce((s, m) => s + num(m.calls), 0) }), (m) => m.calls),
  }

  const days = payloads.flatMap((p) => p.history?.daily ?? [])
  const daily = mergeRows(days, (d) => d.date, (g) => ({
    date: g[0]!.date,
    cost: g.reduce((s, d) => s + num(d.cost), 0),
    savingsUSD: g.reduce((s, d) => s + num(d.savingsUSD), 0),
    calls: g.reduce((s, d) => s + num(d.calls), 0),
    inputTokens: g.reduce((s, d) => s + num(d.inputTokens), 0),
    outputTokens: g.reduce((s, d) => s + num(d.outputTokens), 0),
    cacheReadTokens: g.reduce((s, d) => s + num(d.cacheReadTokens), 0),
    cacheWriteTokens: g.reduce((s, d) => s + num(d.cacheWriteTokens), 0),
    topModels: mergeRows(g.flatMap((d) => d.topModels ?? []), (m) => m.name, (ms) => ({
      name: ms[0]!.name,
      cost: ms.reduce((s, m) => s + num(m.cost), 0),
      savingsUSD: ms.reduce((s, m) => s + num(m.savingsUSD), 0),
      calls: ms.reduce((s, m) => s + num(m.calls), 0),
      inputTokens: ms.reduce((s, m) => s + num(m.inputTokens), 0),
      outputTokens: ms.reduce((s, m) => s + num(m.outputTokens), 0),
    }), (m) => m.cost),
  }), () => 0).sort((a, b) => a.date.localeCompare(b.date))

  return { current, history: { ...local.history, daily } }
}

function parseHostPort(input: string, defaultPort: number): { host: string; port: number } {
  const idx = input.lastIndexOf(':')
  if (idx > 0 && /^\d+$/.test(input.slice(idx + 1))) {
    return { host: input.slice(0, idx), port: Number(input.slice(idx + 1)) }
  }
  return { host: input, port: defaultPort }
}

// Pair with a device the user is currently sharing (PIN shown on that device),
// pin its fingerprint, store the issued token, and persist it.
export async function addRemote(
  input: string,
  pin: string,
  opts: { defaultPort: number; dir?: string },
): Promise<RemoteDevice> {
  const dir = opts.dir ?? getSharingDir()
  const identity = await loadOrCreateIdentity(dir)
  const { host, port } = parseHostPort(input, opts.defaultPort)

  const h = await hello({ identity, host, port })
  if (h.status !== 200) throw new Error(`could not reach a CodeBurn device at ${host}:${port}`)
  const info = h.json as { fingerprint: string; name: string }

  const pr = await pair({ identity, host, port, expectedFingerprint: info.fingerprint }, pin, identity.name)
  if (pr.status !== 200) {
    const err = (pr.json as { error?: string })?.error ?? `HTTP ${pr.status}`
    throw new Error(`pairing failed: ${err}`)
  }
  const token = (pr.json as { token: string }).token

  const device: RemoteDevice = { name: info.name, host, port, fingerprint: info.fingerprint, token, addedAt: Date.now() }
  const remotes = (await loadRemotes(dir)).filter((r) => r.fingerprint !== device.fingerprint)
  remotes.push(device)
  await saveRemotes(remotes, dir)
  return device
}

// Pair with a discovered device using approve-style pairing (no PIN). The owner
// of that device approves on their screen after confirming the matching code.
export async function linkRemote(
  d: DiscoveredDevice,
  opts: { dir?: string; onCode?: (code: string) => void } = {},
): Promise<RemoteDevice> {
  const dir = opts.dir ?? getSharingDir()
  const identity = await loadOrCreateIdentity(dir)
  const code = pairingCode(identity.fingerprint, d.fingerprint)
  opts.onCode?.(code)
  const r = await pairRequest({ identity, host: d.host, port: d.port, expectedFingerprint: d.fingerprint }, identity.name)
  if (r.status !== 200) {
    throw new Error(r.status === 403 ? 'the other device declined' : `pairing failed (HTTP ${r.status})`)
  }
  const token = (r.json as { token: string }).token
  const device: RemoteDevice = { name: d.name, host: d.host, port: d.port, fingerprint: d.fingerprint, token, addedAt: Date.now() }
  const remotes = (await loadRemotes(dir)).filter((x) => x.fingerprint !== device.fingerprint)
  remotes.push(device)
  await saveRemotes(remotes, dir)
  return device
}

// Pull this machine's usage plus every paired remote's, each kept separate.
export async function pullDevices(
  localGetUsage: (q: UsageQuery) => Promise<DevicePayload>,
  query: UsageQuery,
  localName: string,
  opts: { dir?: string } = {},
): Promise<DeviceUsage[]> {
  const dir = opts.dir ?? getSharingDir()
  const identity = await loadOrCreateIdentity(dir)
  const remotes = await loadRemotes(dir)

  const local: DeviceUsage = { id: 'local', name: localName, local: true, payload: await localGetUsage(query) }
  // Pull every remote concurrently and isolate failures, so one slow or
  // powered-off device degrades to an error row instead of blocking the rest.
  const remoteResults = await Promise.all(
    remotes.map(async (r): Promise<DeviceUsage> => {
      try {
        const res = await fetchUsage({ identity, host: r.host, port: r.port, expectedFingerprint: r.fingerprint }, r.token, query)
        // Re-sanitize on receipt: do not trust the sender to have stripped its
        // own project names/sessions (it may run an older build). Belt and
        // suspenders alongside the sender-side sanitize.
        if (res.status === 200) return { id: r.fingerprint, name: r.name, local: false, payload: sanitizeForSharing(res.json as MenubarPayload) }
        return { id: r.fingerprint, name: r.name, local: false, error: res.status === 401 ? 'not authorized (re-pair?)' : `HTTP ${res.status}` }
      } catch (e) {
        return { id: r.fingerprint, name: r.name, local: false, error: e instanceof Error ? e.message : String(e) }
      }
    }),
  )
  return [local, ...remoteResults]
}

// Joined "Totals by machine" report: one row per device plus a bold Combined
// row. Tokens are shown as full, comma-grouped numbers.
export function renderDevices(results: DeviceUsage[]): string {
  const n = (x: number): string => Math.round(x).toLocaleString()
  const money = (x: number): string => formatCost(x).replace(/(?<!\.\d*)(\d)(?=(\d{3})+(\.|$))/g, '$1,')
  const summary = summarizeDeviceUsage(results)
  const rows = summary.perDevice.map((d) => ({
    name: d.name + (d.local ? ' (this Mac)' : ''),
    error: d.error,
    cost: d.cost,
    input: d.inputTokens,
    output: d.outputTokens,
    cacheCreate: d.cacheCreateTokens,
    cacheRead: d.cacheReadTokens,
    total: d.totalTokens,
  }))
  const combined = summary.combined

  const tableRows = [
    ...rows.map((r) =>
      r.error
        ? [r.name, r.error, '-', '-', '-', '-', '-']
        : [r.name, money(r.cost), n(r.total), n(r.input), n(r.output), n(r.cacheCreate), n(r.cacheRead)],
    ),
    ['Combined', money(combined.cost), n(combined.totalTokens), n(combined.inputTokens), n(combined.outputTokens), n(combined.cacheCreateTokens), n(combined.cacheReadTokens)],
  ]
  const table = renderTable(
    [
      { header: 'Host' },
      { header: 'Cost', right: true },
      { header: 'Total tokens', right: true },
      { header: 'Input', right: true },
      { header: 'Output', right: true },
      { header: 'Cache create', right: true },
      { header: 'Cache read', right: true },
    ],
    tableRows,
    { boldRows: new Set([tableRows.length - 1]) },
  )
  const heading = new Chalk({}).cyan('Totals by machine')
  return heading + '\n' + table + '\n'
}
