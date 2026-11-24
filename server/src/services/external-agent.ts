import { randomUUID } from 'node:crypto'
import type { UIMessage } from 'ai'
import type { ExternalAgentBinding, ExternalAgentFrame, ExternalAgentView } from '../../../shared/external-agent.js'
import { getChatStorage, getProjectStorage } from './ai/state.js'
import { abortChat } from './ai/session-ops.js'
import { onChatTurnFinished, onChatTurnStarted, type ChatTurnFinished } from './ai/chat-turn-lifecycle.js'
import { deliverChatMessage } from './ai/chat-delivery.js'
import { getProviderModels } from './ai/providers.js'
import { assistantAgentMode, subagentMode } from './agents/subagent-mode.js'
import { enqueueExternalAgentResult } from './external-agent-notifications.js'
import { listPendingApprovals } from './ai/chat-pending-input.js'
import type { RemoteAgentParent } from '@shared/delegations'
import { externalAgentResultMessage } from './external-agent-result.js'
import { listRemoteAgents, onRemoteAgentChange, reportToParentMachine, startRemoteAgent } from './remote-agents.js'

const listeners = new Set<(event: ExternalAgentFrame) => void>()
const activeTurns = new Map<number, string>()

function publish(event: ExternalAgentFrame): void {
  for (const listener of listeners) {
    try { listener(event) } catch (error) { console.warn('[external-agent] subscriber failed', error) }
  }
}

// Agents this machine's conversations started on other machines join the same feed.
onRemoteAgentChange((agent, created) => publish({ type: created ? 'created' : 'updated', agent }))

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
    updatedAt: meta.updatedAt,
  }
}

/** This machine's external agents, and those its conversations started on other machines. */
export function listExternalAgents(parentChatId?: number): ExternalAgentView[] {
  const local = (getChatStorage()?.listChatEntries({ tp: 'subagent' }) ?? [])
    .filter((entry) => entry.metadata?.externalAgent &&
      (parentChatId === undefined || entry.metadata.externalAgent.parentChatId === parentChatId))
    .flatMap((entry) => externalAgentView(entry.id) ?? [])
  // A remote parent's id is a chat id there: it never matches one of this machine's.
  return [...local, ...listRemoteAgents(parentChatId)]
}

/**
 * Who started an external agent: a parent conversation's id, the personal
 * assistant, or a conversation on another machine of the account.
 */
export type ExternalAgentOwner = number | 'assistant' | Pick<RemoteAgentParent, 'nodeId' | 'chatId'>

/** What the personal assistant is told when one of its conversations finishes a turn. */
export interface AssistantAgentResult {
  view: ExternalAgentView
  event: ChatTurnFinished
  /** The turn's prompt came from the assistant, not from the user typing in the conversation. */
  dispatched: boolean
  /** Everything the turn said. */
  result: string
  /** Its last text part — where an agent concludes, after narrating its work in the earlier ones. */
  final: string
}

let assistantResultSink: ((result: AssistantAgentResult) => void) | undefined

/** The personal assistant's runtime takes the results of the conversations it started. */
export function setAssistantAgentResultSink(sink: ((result: AssistantAgentResult) => void) | undefined): void {
  assistantResultSink = sink
}

const ownedBy = (view: ExternalAgentView, owner: ExternalAgentOwner): boolean => {
  if (owner === 'assistant') return view.assistantActivityId != null
  if (typeof owner === 'object') return view.remoteParent?.nodeId === owner.nodeId && view.remoteParent.chatId === owner.chatId
  return !view.assistantActivityId && !view.remoteParent && view.parentChatId === owner
}

export function ownedExternalAgent(owner: ExternalAgentOwner, agentId: string): ExternalAgentView {
  const match = /^ext-(\d+)$/.exec(agentId)
  const view = match ? externalAgentView(Number(match[1])) : undefined
  if (!view || !ownedBy(view, owner)) {
    throw new Error(owner === 'assistant' ? 'Not a conversation you started' : 'External agent not found in this conversation')
  }
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

export async function sendExternalAgent(owner: ExternalAgentOwner, agentId: string, prompt: string, mode: 'auto' | 'steer' | 'followup' = 'auto') {
  const view = ownedExternalAgent(owner, agentId)
  const message = promptMessage(prompt)
  const receipt = await deliverChatMessage(view.childChatId, message, message.id, mode)
  if (receipt.delivery === 'unknown' || receipt.delivery === 'cancelled') {
    throw new Error(receipt.delivery === 'unknown'
      ? `Delivery is unconfirmed: ${receipt.error ?? 'provider response was lost'}. Do not resend automatically.`
      : 'Delivery was cancelled.')
  }
  const turnId = receipt.requestId
  const status = receipt.delivery === 'followup' ? 'queued' : 'running'
  return { task_id: turnId, turn_id: turnId, agent_id: agentId, chat_id: view.childChatId,
    agent_type: view.providerId, description: view.description, model: view.model, status, delivery: receipt.delivery,
    ...(receipt.error ? { warning: receipt.error } : {}),
    message: 'Accepted. Output streams into the child chat. Its result will return here automatically. If your next step depends on it, end this turn and wait; do not poll.' }
}

export async function createExternalAgent(params: {
  /**
   * A parent conversation, or the assistant naming the workspace. A conversation's child
   * joins its workspace unless it names another one of the same project.
   */
  parent: { chatId: number; workspaceId?: number } | { assistantActivityId: string; workspaceId: number }
  providerId: string; model: string; description: string; prompt: string
  /** Reasoning effort; unset runs at the agent's own level. */
  effort?: string
  /**
   * Run on another machine of the account, in one of its workspaces: the
   * conversation is created there (see remote-agents.ts), this machine keeps a record.
   */
  remote?: { nodeId: string; workspaceId?: number }
} | {
  /** Started from a conversation on another machine, in a workspace of this one. */
  parent: { remoteParent: RemoteAgentParent; workspaceId: number }
  providerId: string; model: string; description: string; prompt: string
  effort?: string
  remote?: undefined
}) {
  const { parent } = params
  if (params.remote) {
    if (!('chatId' in parent)) throw new Error('Only a conversation can start an agent on another machine')
    return startRemoteAgent({
      parentChatId: parent.chatId, nodeId: params.remote.nodeId, workspaceId: params.remote.workspaceId,
      providerId: params.providerId, model: params.model, effort: params.effort,
      description: params.description, prompt: params.prompt,
    })
  }
  const storage = getChatStorage()
  const parentWorkspaceId = 'chatId' in parent ? storage?.getChatMeta(parent.chatId)?.workspaceId : undefined
  const workspaceId = 'chatId' in parent ? parent.workspaceId ?? parentWorkspaceId : parent.workspaceId
  if (!storage || !workspaceId) throw new Error('External agents require an existing workspace conversation')
  if ('remoteParent' in parent && !getProjectStorage()?.getWorkspace(workspaceId)) throw new Error(`There is no workspace ${workspaceId}.`)
  // Elsewhere than the parent's own: only a workspace of the same project.
  const elsewhere = 'chatId' in parent && workspaceId !== parentWorkspaceId
    ? otherWorkspace(parentWorkspaceId, workspaceId)
    : undefined
  const parentChatId = 'chatId' in parent ? parent.chatId : 0
  const owner: ExternalAgentOwner = 'chatId' in parent ? parent.chatId
    : 'remoteParent' in parent ? { nodeId: parent.remoteParent.nodeId, chatId: parent.remoteParent.chatId } : 'assistant'
  const needsModels = params.model === 'default' || !!params.effort
  const models = needsModels ? await getProviderModels(params.providerId) : undefined
  const modelId = params.model === 'default' ? models?.currentModelId || undefined : params.model
  if (params.effort) {
    const levels = models?.configOptions?.find((option) => option.category === 'thought_level')?.options.map((option) => option.value) ?? []
    if (!levels.includes(params.effort)) {
      throw new Error(levels.length ? `Effort levels for ${params.providerId}: ${levels.join(', ')}` : `${params.providerId} has no effort setting`)
    }
  }
  // The assistant's agents can reach the user (its card answers requests), so they ask about risky steps.
  const modeId = 'assistantActivityId' in parent ? assistantAgentMode(params.providerId) : subagentMode(params.providerId)
  const chatId = storage.createChat({
    tp: 'subagent',
    title: `Agent: ${params.description}`, workspaceId,
    providerId: params.providerId, model: modelId,
    ...(params.effort ? { thinkingLevel: params.effort } : {}),
    updatedAt: Date.now(), metadata: { modeId },
  })
  const agentId = `ext-${chatId}`
  storage.updateChatMetadata(chatId, { modeId, externalAgent: {
    agentId, parentChatId, description: params.description, model: params.model,
    ...('assistantActivityId' in parent ? { assistantActivityId: parent.assistantActivityId } : {}),
    ...('remoteParent' in parent ? { remoteParent: parent.remoteParent } : {}),
  } })
  const result = await sendExternalAgent(owner, agentId, params.prompt)
  const view = externalAgentView(chatId)
  if (view) publish({ type: 'created', agent: view })
  // Its changes are not in the parent's worktree: say where they are.
  return elsewhere ? { ...result, workspace_id: workspaceId, branch: elsewhere.branchName, worktree_path: elsewhere.worktreePath } : result
}

function otherWorkspace(parentWorkspaceId: number | undefined, workspaceId: number) {
  const projects = getProjectStorage()
  const target = projects?.getWorkspace(workspaceId)
  if (!target) throw new Error(`There is no workspace ${workspaceId}.`)
  const own = parentWorkspaceId ? projects?.getWorkspace(parentWorkspaceId) : null
  if (!own || own.projectId !== target.projectId) throw new Error(`Workspace ${workspaceId} is not in this conversation's project.`)
  return target
}

export function stopExternalAgent(owner: ExternalAgentOwner, agentId: string) {
  const view = ownedExternalAgent(owner, agentId)
  return { agent_id: agentId, stopped: abortChat(view.childChatId) }
}

export function getExternalAgentStatus(owner: ExternalAgentOwner, agentId: string) {
  const view = ownedExternalAgent(owner, agentId)
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
  return { ...view, ...waiting, result: message ? textOf(message).slice(-20_000) : undefined }
}

function textOf(message?: UIMessage): string {
  return message?.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? ''
}

function deliverResult(view: ExternalAgentView, event: ChatTurnFinished): void {
  const history = getChatStorage()?.getChatEntry(view.childChatId)?.messages as UIMessage[] | undefined
  const dispatched = (event.prompt?.metadata as { externalAgentDispatch?: boolean } | undefined)?.externalAgentDispatch === true ||
    (history ?? []).some((message) => {
      const meta = message.metadata as { externalAgentDispatch?: boolean; turnMessageId?: string } | undefined
      return meta?.externalAgentDispatch === true && meta.turnMessageId != null && meta.turnMessageId === event.prompt?.id
    })
  const result = textOf(event.message).slice(-20_000)
  if (view.assistantActivityId) {
    const final = event.message?.parts.filter((part) => part.type === 'text').at(-1)?.text.trim() ?? ''
    assistantResultSink?.({ view, event, dispatched, result, final })
    return
  }
  if (view.remoteParent) {
    // The parent is on another machine: it gets the turn as data and says it in its own words.
    const own = view.workspaceId != null ? getProjectStorage()?.getWorkspace(view.workspaceId) : undefined
    reportToParentMachine(view.remoteParent, {
      type: 'result', childChatId: view.childChatId, turnId: event.turnId,
      status: event.status === 'completed' || event.status === 'cancelled' ? event.status : 'failed',
      ...(event.error ? { error: event.error } : {}),
      dispatched, prompt: textOf(event.prompt).slice(0, 8_000), result,
      ...(own ? { workspace: { id: own.id, branch: own.branchName, worktreePath: own.worktreePath } } : {}),
    })
    return
  }
  const parent = getChatStorage()?.getChatMeta(view.parentChatId)
  if (!parent) return
  // Working in a workspace of its own: its changes are there, not in the parent's worktree.
  const workspace = view.workspaceId != null && view.workspaceId !== parent.workspaceId
    ? getProjectStorage()?.getWorkspace(view.workspaceId)
    : undefined
  enqueueExternalAgentResult(view.parentChatId, externalAgentResultMessage({
    agentId: view.agentId, providerId: view.providerId, description: view.description, childChatId: view.childChatId,
    turnId: event.turnId, status: event.status, error: event.error, dispatched,
    prompt: textOf(event.prompt), result,
    ...(workspace ? { workspace: { id: workspace.id, branch: workspace.branchName, worktreePath: workspace.worktreePath } } : {}),
  }, `external-result-${event.turnId}`))
}

onChatTurnStarted((payload) => {
  if (!payload.chatId || !payload.requestId || !externalAgentView(payload.chatId)) return
  activeTurns.set(payload.chatId, payload.requestId)
  updateTurn(payload.chatId, { turnId: payload.requestId, status: 'running' })
  const parent = externalAgentView(payload.chatId)?.remoteParent
  if (parent) reportToParentMachine(parent, { type: 'turn', childChatId: payload.chatId, turnId: payload.requestId, status: 'running' })
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
})
