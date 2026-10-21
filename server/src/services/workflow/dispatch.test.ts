import { describe, expect, it, vi } from 'vitest'

/** Chats created, by id. */
const chats = new Map<number, { tp?: string; title?: string; providerId?: string; workspaceId?: number; metadata?: unknown }>()
/** Turns still running, by chat — closed by `abortChat`. */
const running = new Map<number, () => void>()
const destroyed: number[] = []
/** Parts a provider streams before it finishes, by provider. */
const scripted: Record<string, Array<{ type: string; [key: string]: unknown }>> = {}

vi.mock('../ai/state.js', () => ({
  getChatStorage: () => ({
    patchChatEntry: (_id: null, input: { tp?: string; title?: string; providerId?: string; workspaceId?: number; metadata?: unknown }) => {
      const chatId = chats.size + 1
      chats.set(chatId, input)
      return { success: true, chatId, revision: 1 }
    },
    getChatMeta: (chatId: number) => (chatId === 7 ? { workspaceId: 3 } : undefined),
  }),
}))
vi.mock('../agents/subagent-mode.js', () => ({ subagentMode: () => 'fullAccess' }))
vi.mock('../agents/detached-approvals.js', () => ({
  watchDetachedApprovals: () => ({ onPart: vi.fn(), dispose: vi.fn() }),
}))
vi.mock('../ai.js', () => ({
  getSessionManager: () => ({
    get: () => undefined,
    destroy: vi.fn(async (chatId: number) => {
      destroyed.push(chatId)
    }),
  }),
  abortChat: (chatId: number) => {
    running.get(chatId)?.()
    return running.delete(chatId)
  },
  // The first provider never answers until it is stopped; any other answers at once.
  startServerChat: vi.fn(
    async (
      payload: { chatId: number; providerId: string },
      options: { onPart?: (part: { type: string }) => void },
    ) => {
      let aborted = false
      const preparedParts = new ReadableStream({
        start(controller) {
          for (const part of scripted[payload.providerId] ?? []) options.onPart?.(part)
          if (payload.providerId !== 'opencode') return controller.close()
          running.set(payload.chatId, () => {
            aborted = true
            controller.close()
          })
        },
      })
      return {
        preparedParts,
        persistDone: Promise.resolve(),
        finish: vi.fn(),
        recordError: vi.fn(),
        completion: () => ({
          status: aborted ? 'cancelled' : 'completed',
          message: aborted
            ? undefined
            : { role: 'assistant', parts: [{ type: 'text', text: `answer from ${payload.providerId}` }] },
        }),
      }
    },
  ),
}))

const { runProviderAgent } = await import('./dispatch.js')
const { replaceLiveAgent } = await import('./live-agents.js')

describe('a sub-agent runs as a chat', () => {
  it('creates its chat, runs its prompt there and returns the reply', async () => {
    chats.clear()
    const onChats = vi.fn()
    const result = await runProviderAgent({
      providerId: 'codex',
      cwd: '/tmp/wt',
      prompt: 'judge it',
      agentId: 'codex-1',
      title: 'judge · codex',
      parentChatId: 7,
      live: { runId: 'run-a', index: 4 },
      onChats,
      signal: new AbortController().signal,
    })
    expect(result).toBe('answer from codex')
    expect([...chats.values()]).toEqual([
      expect.objectContaining({
        tp: 'workflow-agent',
        title: 'judge · codex',
        providerId: 'codex',
        // The launching conversation's workspace, when none is named.
        workspaceId: 3,
        metadata: { modeId: 'fullAccess', workflowAgent: { runId: 'run-a', index: 4, parentChatId: 7, cwd: '/tmp/wt' } },
      }),
    ])
    expect(onChats).toHaveBeenCalledWith([1])
    // The chat stays; its warm session is let go.
    expect(destroyed).toContain(1)
  })

  it('fails a turn that finished with an error', async () => {
    scripted.kimi = [{ type: 'finish', finishReason: 'error' }]
    await expect(
      runProviderAgent({ providerId: 'kimi', cwd: '/tmp', prompt: 'p', agentId: 'kimi-1', signal: new AbortController().signal }),
    ).rejects.toThrow('answer from kimi')
  })
})

describe('handing a running sub-agent to another provider', () => {
  it('runs the same prompt on the new provider, in a new chat, and returns its answer', async () => {
    chats.clear()
    const onReplaced = vi.fn()
    const onChats = vi.fn()
    const result = runProviderAgent({
      providerId: 'opencode',
      cwd: '/tmp',
      prompt: 'design it',
      agentId: 'opencode-1',
      live: { runId: 'run-x', index: 3 },
      modelFor: (id) => (id === 'codex' ? 'gpt-5.6-terra' : undefined),
      onReplaced,
      onChats,
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => expect(running.size).toBe(1))

    expect(replaceLiveAgent('run-x', 3, { providerId: 'codex' })).toEqual({ success: true })

    await expect(result).resolves.toBe('answer from codex')
    expect([...chats.values()].map((c) => c.providerId)).toEqual(['opencode', 'codex'])
    expect(onReplaced).toHaveBeenCalledWith(
      { providerId: 'opencode', modelId: undefined },
      { providerId: 'codex', modelId: 'gpt-5.6-terra' },
    )
    // Both chats are the row's: the stopped one is kept.
    expect(onChats).toHaveBeenLastCalledWith([1, 2])
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
    await vi.waitFor(() => expect(running.size).toBe(1))
    run.abort()
    await expect(result).rejects.toThrow()
  })
})
