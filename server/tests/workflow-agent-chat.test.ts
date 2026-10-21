import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { RuntimeStreamPart } from '@operon/agent-runtime'
import { makeTestApp, registerFakeScript, type TestApp } from './helpers/make-app.js'

// The fake provider has no entry in the unattended-mode table.
vi.mock('../src/services/agents/subagent-mode.js', () => ({ subagentMode: () => 'default' }))

const { runProviderAgent } = await import('../src/services/workflow/dispatch.js')
const { readAgentChatChunks } = await import('../src/services/workflow/agent-chats.js')
const { getSessionManager } = await import('../src/services/ai.js')

const reply = (text: string, finishReason = 'stop') =>
  async function* () {
    yield { type: 'text-start', id: 'b' } as RuntimeStreamPart
    yield { type: 'text-delta', id: 'b', text } as RuntimeStreamPart
    yield { type: 'text-end', id: 'b' } as RuntimeStreamPart
    yield { type: 'finish', finishReason, totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as RuntimeStreamPart
  }

describe('a workflow sub-agent is a chat', () => {
  let ctx: TestApp

  beforeEach(async () => {
    ctx = await makeTestApp()
  })

  afterEach(() => {
    ctx.cleanup()
  })

  it('stores its prompt and reply as a chat that its run row names', async () => {
    registerFakeScript('judge', reply('Candidate A wins.'))
    const onChats = vi.fn()
    const text = await runProviderAgent({
      providerId: 'fake',
      modelId: 'fake-1',
      cwd: ctx.workspaceCwd,
      prompt: 'Judge the candidates.',
      agentId: 'fake-a1',
      title: 'judge · fake',
      workspaceId: ctx.workspaceId,
      live: { runId: 'run-1', index: 2 },
      onChats,
      signal: new AbortController().signal,
    })

    expect(text).toBe('Candidate A wins.')
    const chatId = onChats.mock.calls[0]![0][0] as number
    const entry = ctx.storage.getChatEntry(chatId)!
    expect(entry).toMatchObject({ tp: 'workflow-agent', title: 'judge · fake', providerId: 'fake', workspaceId: ctx.workspaceId })
    expect(entry.metadata?.workflowAgent).toEqual({ runId: 'run-1', index: 2, parentChatId: null, cwd: ctx.workspaceCwd })
    const messages = entry.messages as UIMessage[]
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[0]!.parts).toEqual([{ type: 'text', text: 'Judge the candidates.' }])

    // The run panel reads it back from the chat.
    expect(readAgentChatChunks([chatId])).toContainEqual({ type: 'text-delta', delta: 'Candidate A wins.' })
    // Reached from its run, not listed among the workspace's conversations.
    expect(ctx.storage.listChatEntries({ workspaceId: ctx.workspaceId }).map((c) => c.id)).not.toContain(chatId)
    // Its warm session is gone; the chat is not.
    expect(getSessionManager().get(chatId)).toBeUndefined()
  })

  it('fails when the turn finished with an error, keeping the chat', async () => {
    registerFakeScript('limit', reply('Usage limit reached.', 'error'))
    const onChats = vi.fn()
    await expect(
      runProviderAgent({
        providerId: 'fake',
        cwd: ctx.workspaceCwd,
        prompt: 'p',
        agentId: 'fake-a2',
        workspaceId: ctx.workspaceId,
        onChats,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Usage limit reached.')
    expect(ctx.storage.getChatEntry(onChats.mock.calls[0]![0][0])?.tp).toBe('workflow-agent')
  })
})
