import type { ExternalAgentView } from '@shared/external-agent'
import type { PendingInputSummary } from '@shared/pending-input'

/**
 * The external agents one conversation started (`parentChatId`), as one list for
 * the Session panel's Agents card.
 *
 * Only external agents: each runs in a conversation of its own, usually not on
 * screen, so nothing else in the parent says how they are doing. A runtime's own
 * subagents (Claude Code's, operon's) run inside the parent's session — the thread
 * shows their steps and the Session panel lists their tasks already.
 */

/** Ordered by how much it needs a look: the in-play states first, the finished ones after. */
export type ChildState = 'needs-you' | 'failed' | 'running' | 'done' | 'stopped'

const STATE_RANK: Record<ChildState, number> = { 'needs-you': 0, failed: 1, running: 2, done: 3, stopped: 4 }

/** Still in play, or finished in a way that wants a look. Shown above the fold. */
export function isActiveState(state: ChildState): boolean {
  return state === 'needs-you' || state === 'failed' || state === 'running'
}

export interface ChatChild {
  key: string
  agentId: string
  childChatId: number
  providerId: string
  modelId?: string
  modeId?: string
  /** Where it works: its parent's workspace, or one of its own. */
  workspaceId?: number
  title: string
  state: ChildState
  /** Why it failed. */
  detail?: string
  /** What it is waiting on the user for. */
  pending: PendingInputSummary[]
  /** Last change, for newest-first within a state; undefined sorts last. */
  at?: number
}

export interface ChatChildrenInput {
  chatId: number
  externalAgents: Iterable<ExternalAgentView>
  pendingByChat: ReadonlyMap<number, PendingInputSummary[]>
}

function childState(view: ExternalAgentView, pending: readonly PendingInputSummary[]): ChildState {
  if (pending.length > 0) return 'needs-you'
  switch (view.status) {
    case 'queued':
    case 'running':
      return 'running'
    case 'failed':
      return 'failed'
    case 'cancelled':
    case 'interrupted':
      return 'stopped'
    // `idle`: no turn on record, so nothing is running.
    default:
      return 'done'
  }
}

export function buildChatChildren(input: ChatChildrenInput): ChatChild[] {
  const children: ChatChild[] = []
  for (const view of input.externalAgents) {
    // The assistant's agents have parentChatId 0, so they never match a real chat.
    if (view.parentChatId !== input.chatId || view.assistantActivityId) continue
    const pending = input.pendingByChat.get(view.childChatId) ?? []
    const state = childState(view, pending)
    children.push({
      key: view.agentId,
      agentId: view.agentId,
      childChatId: view.childChatId,
      providerId: view.providerId,
      modelId: view.modelId,
      modeId: view.modeId,
      workspaceId: view.workspaceId,
      title: view.description,
      state,
      detail: state === 'failed' ? view.error : undefined,
      pending,
      at: view.updatedAt,
    })
  }
  return children.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (b.at ?? 0) - (a.at ?? 0))
}

export interface ChildCounts {
  total: number
  needsYou: number
  failed: number
  running: number
  finished: number
}

export function childCounts(children: readonly ChatChild[]): ChildCounts {
  const counts: ChildCounts = { total: children.length, needsYou: 0, failed: 0, running: 0, finished: 0 }
  for (const child of children) {
    if (child.state === 'needs-you') counts.needsYou++
    else if (child.state === 'failed') counts.failed++
    else if (child.state === 'running') counts.running++
    else counts.finished++
  }
  return counts
}
