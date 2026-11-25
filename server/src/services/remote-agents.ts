import type { StorageAdapter } from '../storage/interface.js'
import type { ExternalAgentTurnStatus, ExternalAgentView } from '@shared/external-agent'
import {
  DELEGATED_AGENT_EVENTS_PATH, REMOTE_AGENT_ID, remoteAgentId,
  type DelegatedAgentCall, type DelegatedAgentCreate, type DelegatedAgentEvent, type DelegatedAgentStarted,
  type DelegationWorkspace, type RemoteAgentParent,
} from '@shared/delegations'
import { DelegationHttpError, delegationRequest, listDelegationNodes } from './delegation-transport.js'
import { enqueueExternalAgentResult } from './external-agent-notifications.js'
import { externalAgentResultMessage } from './external-agent-result.js'

/**
 * External agents across machines of the account.
 *
 * On the origin (the machine whose conversation started the agent): a record
 * per agent, which is what its parent's Agents card lists and what
 * `external_agent_send/stop/status` route through. The agent itself — its
 * conversation, workspace, turns and approvals — is an ordinary external agent
 * of the target machine.
 *
 * On the target: an outbox of turn events for the origin, kept on disk and
 * delivered in order, so a result survives either machine going offline.
 */

const RECORDS_KEY = 'remote-agents:records'
const OUTBOX_KEY = 'remote-agents:outbox'
/** Results already handed to a parent, per agent: a retried delivery is not a second result. */
const DELIVERED_LIMIT = 50
const RETRY_MS = 30_000
/** An event the origin has not taken in a day is dropped: its conversation has moved on. */
const OUTBOX_TTL_MS = 24 * 60 * 60_000

interface RemoteAgentRecord {
  agentId: string
  nodeId: string
  machine: string
  parentChatId: number
  /** The target's chat and workspace ids. */
  childChatId: number
  workspaceId: number
  /** "project / workspace" on the target, for display. */
  workspace: string
  providerId: string
  modelId?: string
  effort?: string
  modeId?: string
  description: string
  model: string
  lastTurn?: { turnId: string; status: ExternalAgentTurnStatus; error?: string }
  delivered: string[]
  updatedAt: number
}

interface OutboxEntry {
  parent: RemoteAgentParent
  event: DelegatedAgentEvent
  queuedAt: number
}

let storage: StorageAdapter | null = null
const listeners = new Set<(view: ExternalAgentView, created: boolean) => void>()

export function initRemoteAgents(store: StorageAdapter): () => void {
  storage = store
  const timer = setInterval(() => void flushOutbox(), RETRY_MS)
  timer.unref?.()
  void flushOutbox()
  return () => clearInterval(timer)
}

/** A record changed (or was created): the origin's external-agents feed republishes it. */
export function onRemoteAgentChange(listener: (view: ExternalAgentView, created: boolean) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function isRemoteAgentId(agentId: string): boolean {
  return REMOTE_AGENT_ID.test(agentId)
}

// ── Origin ──────────────────────────────────────────────────────────────────

const records = (): RemoteAgentRecord[] => storage?.get<RemoteAgentRecord[]>(RECORDS_KEY) ?? []

function saveRecord(record: RemoteAgentRecord, created = false): void {
  if (!storage) throw new Error('Remote agents are not initialized')
  const rest = records().filter((item) => item.agentId !== record.agentId)
  storage.set(RECORDS_KEY, [...rest, record])
  const view = viewOf(record)
  for (const listener of listeners) {
    try { listener(view, created) } catch (error) { console.warn('[remote-agents] subscriber failed', error) }
  }
}

function viewOf(record: RemoteAgentRecord): ExternalAgentView {
  return {
    agentId: record.agentId, parentChatId: record.parentChatId, description: record.description, model: record.model,
    ...(record.lastTurn ? { lastTurn: record.lastTurn } : {}),
    childChatId: record.childChatId, providerId: record.providerId, modelId: record.modelId, modeId: record.modeId,
    effort: record.effort,
    workspaceId: record.workspaceId, turnId: record.lastTurn?.turnId, status: record.lastTurn?.status ?? 'idle',
    error: record.lastTurn?.error, updatedAt: record.updatedAt,
    remote: { nodeId: record.nodeId, machine: record.machine, workspace: record.workspace },
  }
}

export function listRemoteAgents(parentChatId?: number): ExternalAgentView[] {
  return records().filter((record) => parentChatId === undefined || record.parentChatId === parentChatId).map(viewOf)
}

function ownedRecord(parentChatId: number, agentId: string): RemoteAgentRecord {
  const record = records().find((item) => item.agentId === agentId)
  if (!record || record.parentChatId !== parentChatId) throw new Error('External agent not found in this conversation')
  return record
}

/** Which workspace of the target, by the catalog it serves (it lists only what it lets other machines use). */
async function resolveTarget(providerId: string, nodeId: string, workspaceId?: number) {
  const [machines, catalog] = await Promise.all([
    listDelegationNodes(),
    delegationRequest<{ workspaces: DelegationWorkspace[] }>(nodeId,
      `/api/delegations/catalog?provider=${encodeURIComponent(providerId)}&models=0`),
  ])
  const machine = machines.find((item) => item.nodeId === nodeId && !item.current)
  if (!machine) throw new Error('That machine is not on this account')
  const label = machine.label || machine.nodeId
  const { workspaces } = catalog
  if (!workspaces.length) throw new Error(`${label} has no workspaces`)
  const workspace = workspaceId === undefined && workspaces.length === 1
    ? workspaces[0]
    : workspaces.find(({ id }) => id === workspaceId)
  if (!workspace) {
    throw new Error(`Choose a workspace on ${label}: ${workspaces.map(({ id, project, name }) => `${id} (${project} / ${name})`).join(', ')}`)
  }
  return { machine: label, workspace }
}

export async function startRemoteAgent(params: {
  parentChatId: number
  nodeId: string
  workspaceId?: number
  providerId: string
  model: string
  effort?: string
  description: string
  prompt: string
}) {
  const { machine, workspace } = await resolveTarget(params.providerId, params.nodeId, params.workspaceId)
  const request: DelegatedAgentCreate = {
    parentChatId: params.parentChatId, providerId: params.providerId, model: params.model,
    ...(params.effort ? { effort: params.effort } : {}),
    description: params.description, prompt: params.prompt, workspaceId: workspace.id,
  }
  const started = await delegationRequest<DelegatedAgentStarted>(params.nodeId, '/api/delegations/agents', request)
  const record: RemoteAgentRecord = {
    agentId: remoteAgentId(params.nodeId, started.childChatId), nodeId: params.nodeId, machine,
    parentChatId: params.parentChatId, childChatId: started.childChatId, workspaceId: started.workspaceId,
    workspace: `${workspace.project} / ${workspace.name}`, providerId: started.providerId,
    effort: started.effort,
    modelId: started.modelId, modeId: started.modeId, description: params.description, model: params.model,
    lastTurn: { turnId: started.turnId, status: started.status }, delivered: [], updatedAt: Date.now(),
  }
  saveRecord(record, true)
  return {
    task_id: started.turnId, turn_id: started.turnId, agent_id: record.agentId, chat_id: started.childChatId,
    agent_type: record.providerId, description: record.description, model: record.model, status: started.status,
    delivery: started.delivery, machine, workspace: record.workspace,
    ...(started.warning ? { warning: started.warning } : {}),
    message: `Accepted on ${machine}. Output streams into the agent's chat there. Its result will return here automatically. If your next step depends on it, end this turn and wait; do not poll.`,
  }
}

const callPath = (record: RemoteAgentRecord, action: 'send' | 'stop' | 'status') =>
  `/api/delegations/agents/${record.childChatId}/${action}`

/** The target's answer, with its agent id replaced by the one the parent knows. */
function asParentSees<T extends Record<string, unknown>>(record: RemoteAgentRecord, value: T): T {
  const out: Record<string, unknown> = { ...value, machine: record.machine }
  if ('agent_id' in out) out.agent_id = record.agentId
  if ('agentId' in out) out.agentId = record.agentId
  delete out.remoteParent
  return out as T
}

export async function sendRemoteAgent(parentChatId: number, agentId: string, prompt: string, mode: 'auto' | 'steer' | 'followup') {
  const record = ownedRecord(parentChatId, agentId)
  const call: DelegatedAgentCall = { parentChatId, prompt, mode }
  const result = await delegationRequest<{ turn_id: string; status: 'running' | 'queued' } & Record<string, unknown>>(
    record.nodeId, callPath(record, 'send'), call)
  saveRecord({ ...ownedRecord(parentChatId, agentId), lastTurn: { turnId: result.turn_id, status: result.status }, updatedAt: Date.now() })
  return asParentSees(record, result)
}

export async function stopRemoteAgent(parentChatId: number, agentId: string) {
  const record = ownedRecord(parentChatId, agentId)
  const call: DelegatedAgentCall = { parentChatId }
  return asParentSees(record, await delegationRequest<Record<string, unknown>>(record.nodeId, callPath(record, 'stop'), call))
}

/** Asks the target (the record may be behind, e.g. after this machine was off), and catches the record up. */
export async function remoteAgentStatus(parentChatId: number, agentId: string) {
  const record = ownedRecord(parentChatId, agentId)
  const call: DelegatedAgentCall = { parentChatId }
  const status = await delegationRequest<ExternalAgentView & Record<string, unknown>>(record.nodeId, callPath(record, 'status'), call)
  if (status.lastTurn && (status.lastTurn.turnId !== record.lastTurn?.turnId || status.lastTurn.status !== record.lastTurn?.status)) {
    saveRecord({ ...record, lastTurn: { turnId: status.lastTurn.turnId, status: status.lastTurn.status, error: status.lastTurn.error }, updatedAt: Date.now() })
  }
  return asParentSees(record, { ...status, remote: { nodeId: record.nodeId, machine: record.machine, workspace: record.workspace } })
}

/** A turn event from the target. Only for an agent this machine started there; anything else is refused. */
export function receiveAgentEvent(sourceNodeId: string, event: DelegatedAgentEvent): void {
  const record = records().find((item) => item.nodeId === sourceNodeId && item.childChatId === event.childChatId)
  if (!record) throw new DelegationHttpError(404, 'No such agent was started from this machine', 'unknown_agent')
  if (event.type === 'settings') {
    saveRecord({ ...record, modelId: event.modelId, effort: event.effort, updatedAt: Date.now() })
    return
  }
  if (event.type === 'turn') {
    saveRecord({ ...record, lastTurn: { turnId: event.turnId, status: event.status }, updatedAt: Date.now() })
    return
  }
  const lastTurn = { turnId: event.turnId, status: event.status, ...(event.error ? { error: event.error } : {}) }
  if (record.delivered.includes(event.turnId)) {
    saveRecord({ ...record, lastTurn, updatedAt: Date.now() })
    return
  }
  saveRecord({ ...record, lastTurn, delivered: [...record.delivered, event.turnId].slice(-DELIVERED_LIMIT), updatedAt: Date.now() })
  enqueueExternalAgentResult(record.parentChatId, externalAgentResultMessage({
    agentId: record.agentId, providerId: record.providerId, description: record.description,
    childChatId: record.childChatId, machine: record.machine, turnId: event.turnId, status: event.status, error: event.error,
    dispatched: event.dispatched, prompt: event.prompt, result: event.result, workspace: event.workspace,
  }, `external-result-${record.nodeId.slice(0, 8)}-${event.turnId}`))
}

// ── Target ──────────────────────────────────────────────────────────────────

const outbox = (): OutboxEntry[] => storage?.get<OutboxEntry[]>(OUTBOX_KEY) ?? []

/** Tell the machine whose conversation started this agent about one of its turns. */
export function reportToParentMachine(parent: RemoteAgentParent, event: DelegatedAgentEvent): void {
  if (!storage) return
  storage.set(OUTBOX_KEY, [...outbox(), { parent, event, queuedAt: Date.now() }])
  void flushOutbox()
}

let flushing = false
let flushAgain = false

/** Oldest first; a machine that cannot be reached keeps its events (in order) for the next round. */
async function flushOutbox(): Promise<void> {
  if (!storage) return
  if (flushing) { flushAgain = true; return }
  flushing = true
  try {
    do {
      flushAgain = false
      const blocked = new Set<string>()
      for (const entry of outbox()) {
        const node = entry.parent.nodeId
        if (blocked.has(node)) continue
        let done = Date.now() - entry.queuedAt > OUTBOX_TTL_MS
        if (!done) {
          try {
            await delegationRequest(node, DELEGATED_AGENT_EVENTS_PATH, entry.event)
            done = true
          } catch (error) {
            // The origin does not know this agent (its record is gone): nothing will take it.
            if (error instanceof DelegationHttpError && (error.status === 404 || error.status === 400)) done = true
            else blocked.add(node)
          }
        }
        if (done) storage.set(OUTBOX_KEY, outbox().filter((item) => !sameEntry(item, entry)))
      }
    } while (flushAgain)
  } finally {
    flushing = false
  }
}

const eventKey = (event: DelegatedAgentEvent) => event.type === 'settings' ? event.eventId : event.turnId
const sameEntry = (a: OutboxEntry, b: OutboxEntry) =>
  a.queuedAt === b.queuedAt && a.parent.nodeId === b.parent.nodeId && eventKey(a.event) === eventKey(b.event) && a.event.type === b.event.type

