import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { RuntimeStreamPart } from '@operon/agent-runtime'
import { makeTestApp, registerFakeScript, type TestApp } from './helpers/make-app.js'
import { getSessionManager, shutdown } from '../src/services/ai/state.js'
import { handleChat } from '../src/services/ai/chat-flow.js'
import { getLiveTurn, getLiveTurnStatus } from '../src/services/ai/live-turn-hub.js'
import { beginChatTurn, emitChatTurnFinished, isChatTurnBusy } from '../src/services/ai/chat-turn-lifecycle.js'
import { clearExternalAgentNotifications } from '../src/services/external-agent-notifications.js'
import { handleSessionCleanup } from '../src/services/ai/session-ops.js'
import { createExternalAgent, sendExternalAgent, stopExternalAgent, getExternalAgentStatus, setAssistantAgentResultSink, type AssistantAgentResult } from '../src/services/external-agent.js'

vi.mock('@operon/agent-runtime/codex', async () => {
  const { fakeAgent } = await import('@operon/agent-runtime/testing')
  return {
    codex: () => ({
      ...fakeAgent(),
      id: 'codex',
      info: { id: 'codex', label: 'Codex', logo: 'codex' },
    }),
  }
})

vi.mock('../src/services/ai/rewind.js', async (original) => ({
  ...await original<typeof import('../src/services/ai/rewind.js')>(),
  captureCheckpointIfNeeded: async () => undefined,
  captureTurnEndSnapshot: async () => {},
}))

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for external agent')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const text = (message: UIMessage) => message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('')

describe('server-owned external agent conversations', () => {
  let ctx: TestApp
  let parentChatId: number
  let unblockParent: (() => void) | undefined
  beforeEach(async () => {
    ctx = await makeTestApp()
    parentChatId = ctx.storage.createChat({ tp: 'chat', title: 'Chat', providerId: 'fake', model: 'fake-1',
      workspaceId: ctx.workspaceId, updatedAt: Date.now() })
    registerFakeScript('external', async function* ({ session, delay }) {
      yield { type: 'start' } as RuntimeStreamPart
      yield { type: 'text-start', id: 'text' } as RuntimeStreamPart
      yield { type: 'text-delta', id: 'text', text: `turn ${session.turnIndex}: ` } as RuntimeStreamPart
      if (session.userMessage === 'slow') await delay(30_000)
      if (session.userMessage === 'fail') throw new Error('Intentional provider failure')
      yield { type: 'text-delta', id: 'text', text: session.userMessage.includes('<external-agent-result>') ? 'parent received' : session.userMessage } as RuntimeStreamPart
      yield { type: 'text-end', id: 'text' } as RuntimeStreamPart
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } as RuntimeStreamPart
    })
  })
  afterEach(async () => {
    setAssistantAgentResultSink(undefined)
    unblockParent?.()
    unblockParent = undefined
    clearExternalAgentNotifications()
    await shutdown()
    await until(() => !isChatTurnBusy(parentChatId))
    vi.restoreAllMocks()
    ctx?.cleanup()
  })
  const parentResults = () => (ctx.storage.getChatEntry(parentChatId)?.messages as UIMessage[])
    .filter((message) => message.role === 'user' && text(message).includes('<external-agent-result>'))

  it('hands the assistant all replies once after the logical stream finishes and is persisted', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const received: AssistantAgentResult[] = []
    setAssistantAgentResultSink((result) => {
      expect(ctx.storage.getChatEntry(result.view.childChatId)?.messages.some((m) => m.id === result.event.message?.id)).toBe(true)
      received.push(result)
    })
    registerFakeScript('external', async function* () {
      yield { type: 'start' }
      yield { type: 'text-start', id: 'original' }
      yield { type: 'text-delta', id: 'original', text: 'ORIGINAL_DONE' }
      yield { type: 'text-end', id: 'original' }
      await gate
      yield { type: 'text-start', id: 'followup' }
      yield { type: 'text-delta', id: 'followup', text: 'FOLLOWUP_DONE' }
      yield { type: 'text-end', id: 'followup' }
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
    })
    try {
      const child = await createExternalAgent({ parent: { assistantActivityId: 'assistant-task', workspaceId: ctx.workspaceId },
        providerId: 'codex', model: 'fake-1', description: 'Both replies', prompt: 'first and followup' })
      await until(() => !!getSessionManager().get(child.chat_id)?.activeRequest)
      expect(received).toEqual([])
      release()
      await until(() => received.length === 1 && !isChatTurnBusy(child.chat_id))
      expect(received[0].result).toContain('ORIGINAL_DONE')
      expect(received[0].result).toContain('FOLLOWUP_DONE')
      expect(received[0].dispatched).toBe(true)
    } finally { release() }
  })

  it('steers a running child in the same request and persists the follow-up exactly once', async () => {
    const child = await createExternalAgent({ parent: { chatId: parentChatId }, providerId: 'codex', model: 'fake-1', description: 'Review', prompt: 'slow' })
    await until(() => !!getSessionManager().get(child.chat_id)?.activeRequest)
    const session = getSessionManager().get(child.chat_id)!
    const requestId = session.activeRequest!.requestId
    const inject = vi.spyOn(session.runtime, 'steer')
    const follow = await sendExternalAgent(parentChatId, child.agent_id, 'also check tests')
    expect(follow.delivery).toBe('injected')
    expect(follow.turn_id).toBe(requestId)
    expect(session.activeRequest?.requestId).toBe(requestId)
    expect(inject).toHaveBeenCalledTimes(1)
    const history = ctx.storage.getChatEntry(child.chat_id)?.messages as UIMessage[]
    expect(history.filter((m) => m.role === 'user').map(text)).toEqual(['slow', 'also check tests'])
    expect(history.at(-1)?.metadata).toMatchObject({ steer: true, externalAgentDispatch: true })
    stopExternalAgent(parentChatId, child.agent_id)
  })

  it('runs without a tab, exposes replayable output, queues delivery and follows up in the same session', async () => {
    beginChatTurn(parentChatId, 'busy-parent')
    unblockParent = () => emitChatTurnFinished({ chatId: parentChatId, turnId: 'busy-parent', status: 'completed' })
    const child = await createExternalAgent({ parent: { chatId: parentChatId }, providerId: 'codex', model: 'fake-1', description: 'Review', prompt: 'first' })
    await until(() => getExternalAgentStatus(parentChatId, child.agent_id).status === 'completed')
    expect(parentResults()).toHaveLength(0)
    expect(await new Response(getLiveTurn(child.chat_id)!.toReadableStream()).text()).toContain('first')
    const session = getSessionManager().get(child.chat_id)
    expect(session?.params.model).toBe('fake-1')
    handleSessionCleanup(child.chat_id)
    expect(getSessionManager().get(child.chat_id)).toBe(session)
    const next = await sendExternalAgent(parentChatId, child.agent_id, 'second')
    await until(() => getExternalAgentStatus(parentChatId, child.agent_id).status === 'completed' &&
      getExternalAgentStatus(parentChatId, child.agent_id).turnId === next.turn_id)
    expect(getSessionManager().get(child.chat_id)).toBe(session)
    expect(getExternalAgentStatus(parentChatId, child.agent_id).result).toContain('second')
    unblockParent()
    unblockParent = undefined
    await until(() => parentResults().length === 1 && !isChatTurnBusy(parentChatId))
    expect(text(parentResults()[0])).toContain('first')
    expect(text(parentResults()[0])).toContain('second')
    expect((ctx.storage.getChatEntry(parentChatId)?.messages as UIMessage[]).filter((m) => m.role === 'assistant')).toHaveLength(1)
    const history = ctx.storage.getChatEntry(child.chat_id)?.messages as UIMessage[]
    expect(history.filter((message) => message.role === 'user').map(text)).toEqual(['first', 'second'])
  })

  it('cancels the old turn and queued messages; a prompt from the child tab still reports to the parent', async () => {
    const child = await createExternalAgent({ parent: { chatId: parentChatId }, providerId: 'codex', model: 'fake-1', description: 'Review', prompt: 'slow' })
    await until(() => getLiveTurnStatus(child.chat_id).active)
    const runtime = getSessionManager().get(child.chat_id)!.runtime
    Object.defineProperty(runtime, 'steer', { value: undefined, configurable: true })
    await expect(sendExternalAgent(parentChatId, child.agent_id, 'must not execute')).rejects.toThrow('does not support followup')
    expect(stopExternalAgent(parentChatId, child.agent_id).stopped).toBe(true)
    // Submit immediately: a stopped old turn must not overwrite the new turn status.
    const response = await handleChat({ chatId: child.chat_id, providerId: 'wrong-provider', modelId: 'wrong-model',
      messages: [{ id: 'user-follow-up', role: 'user', parts: [{ type: 'text', text: 'revised' }] }] })
    await response.text()
    await until(() => parentResults().length === 1 && !isChatTurnBusy(parentChatId))
    expect(parentResults().map(text).join('\n')).toContain('<status>cancelled</status>')
    const completed = parentResults().find((message) => text(message).includes('<status>completed</status>'))!
    expect(text(completed)).toContain('<prompt-source>user in child chat</prompt-source>')
    expect(text(completed)).toContain('Do not act on it unless the user asks. No reply is needed')
    expect(text(completed)).not.toContain('Use this result to continue')
    expect(text(completed)).toContain('revised')
    expect(getSessionManager().get(child.chat_id)?.params.model).toBe('fake-1')
    const history = ctx.storage.getChatEntry(child.chat_id)?.messages as UIMessage[]
    expect(history.filter((message) => message.role === 'user').map(text)).toEqual(['slow', 'revised'])
  })

  it('rejects a racing notification during user setup without persisting it or starting another turn', async () => {
    const manager = getSessionManager()
    const getOrCreate = manager.getOrCreate.bind(manager)
    const gate = new Promise<void>((resolve) => { unblockParent = resolve })
    vi.spyOn(manager, 'getOrCreate').mockImplementationOnce(async (...args) => {
      await gate
      return getOrCreate(...args)
    })
    const request = { chatId: parentChatId, providerId: 'fake', modelId: 'fake-1', workspaceId: ctx.workspaceId,
      messages: [{ id: 'user-setup', role: 'user' as const, parts: [{ type: 'text' as const, text: 'user task' }] }] }
    const userTurn = handleChat(request)
    const notification = await handleChat({ ...request, messages: [{ id: 'racing-notification', role: 'user',
      parts: [{ type: 'text', text: 'result' }] }] }, undefined, { onlyIfIdle: true })
    expect(notification.status).toBe(409)
    expect((ctx.storage.getChatEntry(parentChatId)?.messages as UIMessage[]).map((m) => m.id)).toEqual(['user-setup'])
    unblockParent!()
    unblockParent = undefined
    await (await userTurn).text()
    await until(() => !isChatTurnBusy(parentChatId))
  })

  it('merges three child results into one steer while the parent is still running', async () => {
    const response = await handleChat({ chatId: parentChatId, providerId: 'fake', modelId: 'fake-1',
      workspaceId: ctx.workspaceId, messages: [{ id: 'parent-prompt', role: 'user', parts: [{ type: 'text', text: 'slow' }] }] })
    void response.body?.cancel()
    await until(() => getLiveTurnStatus(parentChatId).active)
    const session = getSessionManager().get(parentChatId)!
    const requestId = session.activeRequest!.requestId
    const inject = vi.spyOn(session.runtime, 'steer')
    const children = await Promise.all(['A', 'B', 'C'].map((prompt) => createExternalAgent({
      parent: { chatId: parentChatId }, providerId: 'codex', model: 'fake-1', description: prompt, prompt,
    })))
    await until(() => parentResults().length === 1)
    expect(inject).toHaveBeenCalledTimes(1)
    for (const child of children) expect(inject.mock.calls[0][0]).toContain(`<agent-id>${child.agent_id}</agent-id>`)
    expect(session.activeRequest?.requestId).toBe(requestId)
    expect(getLiveTurnStatus(parentChatId).active).toBe(true)
    expect(parentResults()[0].metadata).toMatchObject({ steer: true, turnMessageId: 'parent-prompt' })
  })

  it('reports a provider stream failure as failed, not a successful partial reply', async () => {
    const child = await createExternalAgent({ parent: { chatId: parentChatId }, providerId: 'codex', model: 'fake-1', description: 'Review', prompt: 'fail' })
    await until(() => parentResults().length === 1 && !isChatTurnBusy(parentChatId))
    expect(getExternalAgentStatus(parentChatId, child.agent_id).status).toBe('failed')
    expect(text(parentResults()[0])).toContain('<status>failed</status>')
    expect(() => getExternalAgentStatus(parentChatId + 999, child.agent_id)).toThrow('not found')
  })

  it('publishes a child chat link independently of the parent panel and restores relationships without rerunning', async () => {
    const response = await ctx.request('/api/external-agents/feed')
    const reader = response.body!.getReader()
    const decode = new TextDecoder()
    expect(decode.decode((await reader.read()).value)).toContain('"type":"sync"')
    const child = await createExternalAgent({ parent: { chatId: parentChatId }, providerId: 'codex', model: 'fake-1', description: 'Review', prompt: 'first' })
    let frames = ''
    while (!frames.includes('"type":"created"')) frames += decode.decode((await reader.read()).value)
    expect(frames).toContain(`"childChatId":${child.chat_id}`)
    await reader.cancel()
    await until(() => parentResults().length === 1 && !isChatTurnBusy(parentChatId))
    const metadata = ctx.storage.getChatMeta(child.chat_id)!.metadata!
    ctx.storage.updateChatMetadata(child.chat_id, { ...metadata, externalAgent: {
      ...metadata.externalAgent!, lastTurn: { turnId: 'before-restart', status: 'running' },
    } })
    expect(getExternalAgentStatus(parentChatId, child.agent_id).status).toBe('interrupted')
    expect(parentResults()).toHaveLength(1)
    const next = await sendExternalAgent(parentChatId, child.agent_id, 'continue after restart')
    await until(() => getExternalAgentStatus(parentChatId, child.agent_id).turnId === next.turn_id &&
      getExternalAgentStatus(parentChatId, child.agent_id).status === 'completed')
    await until(() => parentResults().length === 2 && !isChatTurnBusy(parentChatId))
  })
})
