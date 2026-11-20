import { describe, it, expect } from 'vitest'

import { UsageQueryError } from '../../src/cli-date.js'
import { sharedProviderFromQuery } from '../../src/sharing/share-run.js'

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
