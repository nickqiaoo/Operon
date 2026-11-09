import { describe, expect, it } from 'vitest'
import { toUiMessageMetadata } from './ui-metadata.js'

describe('toUiMessageMetadata', () => {
  it('preserves retry status and explicit clearing through UI conversion', () => {
    const retry = { attempt: 1, maxAttempts: 10, retryAt: 5000, reason: '429' };
    expect(toUiMessageMetadata({ retry })).toEqual({ retry });
    expect(toUiMessageMetadata({ retry: null })).toEqual({ retry: null });
  });
  it('flattens the runtime namespaces into the keys the client and stored messages use', () => {
    const goal = { objective: 'ship it', status: 'active' }
    const claudeLimits = { windows: { five_hour: { status: 'allowed' as const, utilization: 40 } } }
    expect(
      toUiMessageMetadata({
        contextUsage: { promptTokens: 10 },
        goal,
        codex: { account: { type: 'apiKey' }, rateLimits: { primary: {} } },
        'claude-code': { rateLimits: claudeLimits },
      }),
    ).toEqual({
      contextUsage: { promptTokens: 10 },
      codexGoal: goal,
      codexAccount: { type: 'apiKey' },
      codexRateLimits: { primary: {} },
      claudeRateLimits: claudeLimits,
    })
  })

  it('leaves metadata without provider extras as it is', () => {
    expect(toUiMessageMetadata({ compacted: { compacted: true } })).toEqual({ compacted: { compacted: true } })
  })
})
