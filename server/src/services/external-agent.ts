import { randomUUID } from 'node:crypto'
import type { UIMessage } from 'ai'
import type { ExternalAgentBinding, ExternalAgentFrame, ExternalAgentView } from '../../../shared/external-agent.js'
import { getChatStorage } from './ai/state.js'
import { handleChat } from './ai/chat-flow.js'
import { abortChat } from './ai/session-ops.js'
import { isChatTurnBusy, onChatTurnFinished, onChatTurnStarted, onChatTurnAborted, type ChatTurnFinished } from './ai/chat-turn-lifecycle.js'
import { getProviderModels } from './ai/providers.js'
import { subagentMode } from './agents/subagent-mode.js'
import { enqueueExternalAgentResult } from './external-agent-notifications.js'
import { listPendingApprovals } from './ai/chat-pending-input.js'

const listeners = new Set<(event: ExternalAgentFrame) => void>()
const activeTurns = new Map<number, string>()
// Explicit follow-up prompts keep their own child-turn semantics. Only parent
// result notifications are batched/steered; no global handleChat FIFO is needed.
const pendingPrompts = new Map<number, Array<{ turnId: string; message: UIMessage }>>()

function publish(event: ExternalAgentFrame): void {
  for (const listener of listeners) {
    try { listener(event) } catch (error) { console.warn('[external-agent] subscriber failed', error) }
  }
}

export function subscribeExternalAgents(listener: (event: ExternalAgentFrame) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function externalAgentView(childChatId: number): ExternalAgentView | undefined {
  const meta = getChatStorage()?.getChatMeta(childChatId)
  const binding = meta?.metadata?.externalAgent
  if (!binding || !meta?.providerId) return undefined
  const last = binding.lastTurn
  const pending = last?.status === 'running' || last?.status === 'queued'
  return {
    ...binding, childChatId, modelId: meta.model, modeId: meta.metadata?.modeId, providerId: meta.providerId, workspaceId: meta.workspaceId,
    turnId: last?.turnId,
    status: pending && !activeTurns.has(childChatId) ? 'interrupted' : last?.status ?? 'idle',
    error: last?.error,
  }
}

export function listExternalAgents(parentChatId?: number): ExternalAgentView[] {
  return (getChatStorage()?.listChatEntries({ tp: 'subagent' }) ?? [])
    .filter((entry) => entry.metadata?.externalAgent &&
      (parentChatId === undefined || entry.metadata.externalAgent.parentChatId === parentChatId))
    .flatMap((entry) => externalAgentView(entry.id) ?? [])
}

export function ownedExternalAgent(parentChatId: number, agentId: string): ExternalAgentView {
  const match = /^ext-(\d+)$/.exec(agentId)
  const view = match ? externalAgentView(Number(match[1])) : undefined
  if (!view || view.parentChatId !== parentChatId) throw new Error('External agent not found in this conversation')
  return view
}

function updateTurn(chatId: number, lastTurn: NonNullable<ExternalAgentBinding['lastTurn']>): void {
  const storage = getChatStorage()
  const meta = storage?.getChatMeta(chatId)
  if (!storage || !meta?.metadata?.externalAgent) return
  storage.updateChatMetadata(chatId, { ...meta.metadata,
    externalAgent: { ...meta.metadata.externalAgent, lastTurn } })
  const view = externalAgentView(chatId)
  if (view) publish({ type: 'updated', agent: view })
}

function promptMessage(prompt: string): UIMessage {
  return { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: prompt }],
    metadata: { externalAgentDispatch: true } }
}

export function sendExternalAgent(parentChatId: number, agentId: string, prompt: string) {
  const view = ownedExternalAgent(parentChatId, agentId)
  const turnId = randomUUID()
  const status = isChatTurnBusy(view.childChatId) ? 'queued' : 'running'
  if (!activeTurns.has(view.childChatId)) {
    activeTurns.set(view.childChatId, turnId)
    updateTurn(view.childChatId, { turnId, status: 'queued' })
  }
  const queue = pendingPrompts.get(view.childChatId) ?? []
  queue.push({ turnId, message: promptMessage(prompt) })
  pendingPrompts.set(view.childChatId, queue)
  void dispatchNextPrompt(view.childChatId)
  return { task_id: turnId, turn_id: turnId, agent_id: agentId, chat_id: view.childChatId,
    agent_type: view.providerId, description: view.description, model: view.model, status,
    message: 'Accepted. Output streams into the child chat. Its result will return here automatically. If your next step depends on it, end this turn and wait; do not poll.' }
}

async function dispatchNextPrompt(chatId: number): Promise<void> {
  if (isChatTurnBusy(chatId)) return
  const queue = pendingPrompts.get(chatId)
  const next = queue?.shift()
  if (!next) return
  if (!queue?.length) pendingPrompts.delete(chatId)
  const response = await handleChat({ chatId, requestId: next.turnId, messages: [next.message] },
    undefined, { onlyIfIdle: true })
  void response.body?.cancel().catch(() => {})
  if (response.status === 409) {
    const pending = pendingPrompts.get(chatId) ?? []
    pending.unshift(next)
    pendingPrompts.set(chatId, pending)
  }
}

onChatTurnAborted((chatId) => { pendingPrompts.delete(chatId) })

export async function createExternalAgent(params: {
  parentChatId: number; providerId: string; model: string; description: string; prompt: string
}) {
  const storage = getChatStorage()
  const parent = storage?.getChatMeta(params.parentChatId)
  if (!storage || !parent?.workspaceId) throw new Error('External agents require an existing workspace conversation')
  const modelId = params.model === 'default'
    ? (await getProviderModels(params.providerId)).currentModelId || undefined
    : params.model
  const modeId = subagentMode(params.providerId)
  const created = storage.patchChatEntry(null, {
    baseRevision: 0, replaceFrom: 0, tailMessages: [], tp: 'subagent',
    title: `Agent: ${params.description}`, workspaceId: parent.workspaceId,
    providerId: params.providerId, model: modelId,
    updatedAt: Date.now(), metadata: { modeId },
  })
  if (!created.success) throw new Error('Could not create external agent conversation')
  const agentId = `ext-${created.chatId}`
  storage.updateChatMetadata(created.chatId, { modeId, externalAgent: {
    agentId, parentChatId: params.parentChatId, description: params.description, model: params.model,
  } })
  const result = sendExternalAgent(params.parentChatId, agentId, params.prompt)
  const view = externalAgentView(created.chatId)
  if (view) publish({ type: 'created', agent: view })
  return result
}

export function stopExternalAgent(parentChatId: number, agentId: string) {
  const view = ownedExternalAgent(parentChatId, agentId)
  return { agent_id: agentId, stopped: abortChat(view.childChatId) }
}

export function getExternalAgentStatus(parentChatId: number, agentId: string) {
  const view = ownedExternalAgent(parentChatId, agentId)
  const messageId = view.lastTurn?.resultMessageId
  const entry = messageId ? getChatStorage()?.getChatEntry(view.childChatId) : undefined
  const message = (entry?.messages as UIMessage[] | undefined)?.find((item) => item.id === messageId)
  // Blocked on a person, not stuck. Only a person can answer: the request is
  // described so the parent can say what is waiting, never so it can respond.
  const pending = listPendingApprovals(view.childChatId)
  const waiting = pending.length > 0
    ? {
        waiting_for_user: true,
        pending_input: pending.map(({ toolName, inputPreview }) => ({ tool: toolName, preview: inputPreview })),
        message: 'Waiting for the user to respond in the child chat. Do not restart or re-dispatch it; the result will arrive automatically.',
      }
    : {}
  return { ...view, ...waiting, result: message ? textOf(message).slice(0, 20_000) : undefined }
}

function textOf(message?: UIMessage): string {
  return message?.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? ''
}
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

function deliverResult(view: ExternalAgentView, event: ChatTurnFinished): void {
  const parent = getChatStorage()?.getChatMeta(view.parentChatId)
  if (!parent) return
  const source = (event.prompt?.metadata as { externalAgentDispatch?: boolean } | undefined)?.externalAgentDispatch
    ? 'parent agent' : 'user in child chat'
  const result = textOf(event.message).slice(0, 20_000)
  const text = `[External Agent Result]\n<external-agent-result>
<task-id>${event.turnId}</task-id>
<agent-id>${view.agentId}</agent-id>
<agent-type>${escape(view.providerId)}</agent-type>
<description>${escape(view.description)}</description>
<child-chat-id>chat:${view.childChatId}</child-chat-id>
<db-chat-id>${view.childChatId}</db-chat-id>
<status>${event.status}</status>
<prompt-source>${source}</prompt-source>
<prompt>${escape(textOf(event.prompt).slice(0, 8_000))}</prompt>
<result>${escape(event.status === 'completed' ? result : event.error ?? event.status)}</result>
</external-agent-result>
${event.status === 'cancelled' ? 'The user stopped this turn. Do not restart it automatically; wait for further instructions.' : 'Use this result to continue. If the agent is asking the user something, tell the user the question and that they can answer in the agent\'s tab, then end your turn. Do not answer it on the user\'s behalf or send the agent a reply the user did not give. To follow up with this same agent, call external_agent_send with its agent_id.'}`
  const message: UIMessage = { id: `external-result-${event.turnId}`, role: 'user',
    parts: [{ type: 'text', text }], metadata: { externalAgentResult: {
      agentId: view.agentId, turnId: event.turnId, childChatId: view.childChatId, status: event.status,
    } } }
  enqueueExternalAgentResult(view.parentChatId, message)
}

onChatTurnStarted((payload) => {
  if (!payload.chatId || !payload.requestId || !externalAgentView(payload.chatId)) return
  activeTurns.set(payload.chatId, payload.requestId)
  updateTurn(payload.chatId, { turnId: payload.requestId, status: 'running' })
})

onChatTurnFinished((event) => {
  const view = externalAgentView(event.chatId)
  if (!view) {
    if (activeTurns.get(event.chatId) === event.turnId) activeTurns.delete(event.chatId)
    return
  }
  // A preempted turn still reports its cancellation, but cannot overwrite the
  // newer turn's status when its old stream finishes draining.
  if (activeTurns.get(event.chatId) === event.turnId) {
    activeTurns.delete(event.chatId)
    updateTurn(event.chatId, { turnId: event.turnId, status: event.status,
      resultMessageId: event.message?.id, error: event.error })
  }
  deliverResult(view, event)
  void dispatchNextPrompt(event.chatId)
})
