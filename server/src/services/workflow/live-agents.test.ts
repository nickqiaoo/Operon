import { describe, expect, it, vi } from 'vitest'

const injectIntoChat = vi.hoisted(() =>
  vi.fn(async (_chatId: number, _text: string): Promise<{ success: boolean; delivery: string; error?: string }> => ({
    success: true,
    delivery: 'accepted',
  })),
)
vi.mock('../ai/session-ops.js', () => ({ injectIntoChat }))

const { replaceLiveAgent, steerLiveAgent, trackLiveAgent } = await import('./live-agents.js')

describe('steering a running sub-agent', () => {
  it('steers its chat\'s running turn, where the message is stored like any steer', async () => {
    const untrack = trackLiveAgent('run-1', 2, { chatId: 30, providerId: 'opencode', replace: vi.fn() })

    expect(await steerLiveAgent('run-1', 2, '  Stop implementing; sketch only.  ')).toEqual({ success: true })
    expect(injectIntoChat).toHaveBeenCalledWith(30, 'Stop implementing; sketch only.')

    untrack()
    expect(await steerLiveAgent('run-1', 2, 'again')).toEqual({ success: false, error: 'This agent is not running' })
  })

  it('says why a message cannot go through', async () => {
    const untrack = trackLiveAgent('run-2', 0, { chatId: 31, providerId: 'grok', replace: vi.fn() })
    injectIntoChat.mockResolvedValueOnce({ success: false, delivery: 'not-sent', error: 'Current provider does not support steer' })
    expect(await steerLiveAgent('run-2', 0, 'hi')).toEqual({
      success: false,
      error: 'grok does not accept messages while it works',
    })
    expect(await steerLiveAgent('run-2', 0, '   ')).toEqual({ success: false, error: 'Message is empty' })

    injectIntoChat.mockResolvedValueOnce({ success: false, delivery: 'not-sent', error: 'Session is not currently generating' })
    expect(await steerLiveAgent('run-2', 0, 'hi')).toEqual({ success: false, error: 'Session is not currently generating' })
    untrack()
  })

  it('hands a running agent to another provider, but not to the one it is on', () => {
    const replace = vi.fn()
    const untrack = trackLiveAgent('run-4', 0, { chatId: 32, providerId: 'opencode', replace })
    expect(replaceLiveAgent('run-4', 0, { providerId: 'opencode' })).toEqual({
      success: false,
      error: 'This agent is already running on opencode',
    })
    expect(replaceLiveAgent('run-4', 0, { providerId: 'codex' })).toEqual({ success: true })
    expect(replace).toHaveBeenCalledWith({ providerId: 'codex' })
    untrack()
    expect(replaceLiveAgent('run-4', 0, { providerId: 'codex' })).toEqual({
      success: false,
      error: 'This agent is not running',
    })
  })
})
