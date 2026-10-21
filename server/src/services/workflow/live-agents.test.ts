import { describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '@operon/agent-runtime'
import { replaceLiveAgent, steerLiveAgent, trackLiveAgent } from './live-agents.js'

function fakeSession(inject?: AgentSession['inject']): AgentSession {
  return { inject } as unknown as AgentSession
}

describe('steering a running sub-agent', () => {
  it('adds the message to its turn and notes it in its transcript', async () => {
    const inject = vi.fn(async (_text: string, _options?: { id?: string }) => undefined)
    const note = vi.fn()
    const untrack = trackLiveAgent('run-1', 2, { session: fakeSession(inject), providerId: 'opencode', note, replace: vi.fn() })

    expect(await steerLiveAgent('run-1', 2, '  Stop implementing; sketch only.  ')).toEqual({ success: true })
    expect(inject).toHaveBeenCalledWith('Stop implementing; sketch only.', { id: expect.any(String) })
    expect(note).toHaveBeenCalledWith('Stop implementing; sketch only.', inject.mock.calls[0]?.[1]?.id)

    untrack()
    expect(await steerLiveAgent('run-1', 2, 'again')).toEqual({ success: false, error: 'This agent is not running' })
  })

  it('says why a message cannot go through', async () => {
    const untrack = trackLiveAgent('run-2', 0, { session: fakeSession(), providerId: 'grok', note: vi.fn(), replace: vi.fn() })
    expect(await steerLiveAgent('run-2', 0, 'hi')).toEqual({
      success: false,
      error: 'grok does not accept messages while it works',
    })
    expect(await steerLiveAgent('run-2', 0, '   ')).toEqual({ success: false, error: 'Message is empty' })
    untrack()

    const failing = vi.fn(async () => {
      throw new Error('no turn to add it to')
    })
    const note = vi.fn()
    const done = trackLiveAgent('run-3', 1, { session: fakeSession(failing), providerId: 'codex', note, replace: vi.fn() })
    expect(await steerLiveAgent('run-3', 1, 'hi')).toEqual({ success: false, error: 'no turn to add it to' })
    expect(note).not.toHaveBeenCalled()
    done()
  })

  it('hands a running agent to another provider, but not to the one it is on', () => {
    const replace = vi.fn()
    const untrack = trackLiveAgent('run-4', 0, { session: fakeSession(), providerId: 'opencode', note: vi.fn(), replace })
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
