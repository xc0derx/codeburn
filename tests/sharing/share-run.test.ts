import { describe, it, expect, vi } from 'vitest'

import { UsageQueryError } from '../../src/cli-date.js'

const aggregator = vi.hoisted(() => ({
  buildMenubarPayloadForRange: vi.fn(async () => ({ current: { cost: 1, topProjects: [], topSessions: [] }, history: { daily: [] } })),
}))
vi.mock('../../src/usage-aggregator.js', () => aggregator)

const { buildSharedUsage, sharedProviderFromQuery } = await import('../../src/sharing/share-run.js')

describe('sharedProviderFromQuery', () => {
  it('defaults to every provider', () => {
    expect(sharedProviderFromQuery({ period: 'week' })).toBe('all')
  })

  it('accepts a known provider', () => {
    expect(sharedProviderFromQuery({ provider: 'codex' })).toBe('codex')
  })

  it('rejects an unknown provider as a bad request instead of exiting', () => {
    expect(() => sharedProviderFromQuery({ provider: 'not-a-provider' })).toThrow(UsageQueryError)
  })
})

describe('buildSharedUsage', () => {
  it('filters by provider and echoes the filter', async () => {
    const payload = await buildSharedUsage({ period: 'week', provider: 'codex' }, 'month') as { providerFilter?: string }
    expect(aggregator.buildMenubarPayloadForRange).toHaveBeenLastCalledWith(expect.anything(), { provider: 'codex', optimize: false })
    expect(payload.providerFilter).toBe('codex')
  })

  it('sends every provider without an echo by default', async () => {
    const payload = await buildSharedUsage({}, 'today') as { providerFilter?: string }
    expect(aggregator.buildMenubarPayloadForRange).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: expect.any(String) }),
      { provider: 'all', optimize: false },
    )
    expect(payload).not.toHaveProperty('providerFilter')
  })
})
