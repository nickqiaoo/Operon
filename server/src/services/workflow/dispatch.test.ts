import { describe, expect, it, vi } from 'vitest'

const created: string[] = []
vi.mock('../ai.js', () => ({
  getSessionManager: () => ({
    createStandaloneSession: vi.fn(async (providerId: string) => {
      created.push(providerId)
      return { providerId, close: vi.fn(async () => undefined) }
    }),
  }),
}))
vi.mock('../agents/subagent-mode.js', () => ({ subagentMode: () => 'fullAccess' }))
vi.mock('../agents/detached-approvals.js', () => ({
  watchDetachedApprovals: () => ({ onPart: vi.fn(), dispose: vi.fn() }),
}))
vi.mock('../ai/message-utils.js', () => ({ latestUserInput: () => 'input' }))
vi.mock('ai', () => ({ convertToModelMessages: async () => [] }))
// The first provider never answers until it is stopped; any other answers at once.
vi.mock('../ai/agent-turn.js', () => ({
  runAgentTurnText: vi.fn(
    (session: { providerId: string }, input: { signal: AbortSignal }) =>
      new Promise<string>((resolve, reject) => {
        if (session.providerId !== 'opencode') return resolve(`answer from ${session.providerId}`)
        if (input.signal.aborted) return reject(new Error('aborted'))
        input.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  ),
}))

const { runProviderAgent } = await import('./dispatch.js')
const { replaceLiveAgent } = await import('./live-agents.js')

describe('handing a running sub-agent to another provider', () => {
  it('runs the same prompt on the new provider and returns its answer', async () => {
    const chunks: unknown[] = []
    const onReplaced = vi.fn()
    const result = runProviderAgent({
      providerId: 'opencode',
      cwd: '/tmp',
      prompt: 'design it',
      agentId: 'opencode-1',
      live: { runId: 'run-x', index: 3 },
      modelFor: (id) => (id === 'codex' ? 'gpt-5.6-terra' : undefined),
      onReplaced,
      onChunk: (chunk) => chunks.push(chunk),
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => expect(created).toEqual(['opencode']))

    expect(replaceLiveAgent('run-x', 3, { providerId: 'codex' })).toEqual({ success: true })

    await expect(result).resolves.toBe('answer from codex')
    expect(created).toEqual(['opencode', 'codex'])
    expect(onReplaced).toHaveBeenCalledWith(
      { providerId: 'opencode', modelId: undefined },
      { providerId: 'codex', modelId: 'gpt-5.6-terra' },
    )
    expect(chunks).toContainEqual({ type: 'data-replaced', data: { from: 'opencode', to: 'codex' } })
    // Done: nothing left to reach.
    expect(replaceLiveAgent('run-x', 3, { providerId: 'claude-code' }).success).toBe(false)
  })

  it('still stops with the run', async () => {
    const run = new AbortController()
    const result = runProviderAgent({
      providerId: 'opencode',
      cwd: '/tmp',
      prompt: 'p',
      agentId: 'opencode-2',
      signal: run.signal,
    })
    run.abort()
    await expect(result).rejects.toThrow('aborted')
  })
})
