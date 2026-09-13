import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
  NotificationStorageAdapter,
  ProjectStorageAdapter,
  TaskStorageAdapter,
} from '../../storage/interface.js'
import type { Task } from '../../types/task.js'
import { getLinearAppConfig, getLinearDelegationConfig } from '../../services/integration-config.js'
import { findProjectByRepo } from '../../services/integrations/project-repos.js'
import { dispatchProjectTask, wakeTaskBinding } from '../../services/channel/agent-orchestrator.js'
import { handlePermissionResponse } from '../../services/ai/approval.js'
import { abortChat } from '../../services/ai/session-ops.js'
import { broadcastTask } from '../../services/task-events.js'
import { createAgentActivity, fetchLinearIssue } from '../../services/integrations/linear-app.js'
import { getSaasConfig } from '../saas/config.js'
import { answersFor } from './answers.js'
import { recordNonOwnerComment, setReplyTarget } from './task-surface-bridge.js'
import { applyIssueChange, fromLinearPriority, isMirroredComment, recordLinearComment } from './surface-sync.js'
import { REPO_LABEL_PREFIX, repoFromLabels } from './linear-mapping.js'

// Linear AgentSessionEvent / Issue webhooks → task actions
// (docs/linear-github/design.md §8.1–§8.3, §8.5).
//
// The rule for a fresh delegation: nothing runs on incomplete information.
// The issue must name its repository with a `repo:owner/name` label that
// matches a local project's origin; otherwise the session gets an error and
// no task is created. A session on an issue that is already a task here only
// attaches — it never starts or steers the agent (that includes the session
// Linear opens when the desktop publishes a task and assigns the issue to the
// workspace agent).

type Storage = TaskStorageAdapter & ChannelStorageAdapter & ProjectStorageAdapter & NotificationStorageAdapter & AgentBindingStorageAdapter

export interface InboundMeta {
  event: string
  delivery: string
  /** session | issue | creator | sender | pr | installer — which lookup picked this machine. */
  routeReason: string
  /** owner | other | unknown — whether the person who triggered it owns the task here. */
  actor: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

function pick(obj: unknown, path: string): unknown {
  let cur = obj
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function firstStr(obj: unknown, ...paths: string[]): string {
  for (const p of paths) {
    const v = str(pick(obj, p))
    if (v) return v
  }
  return ''
}

interface SessionEvent {
  action: string
  orgId: string
  sessionId: string
  issue: { id: string; identifier: string; title: string; description: string; url: string; teamId: string; projectId: string; priority: number }
  /** Empty when Linear opened the session without a human (automation, the app user). */
  creatorName: string
  /** Root comment of the thread the session lives in; replies there arrive as `prompted`. */
  commentId: string
  /** The words that came with this delivery: the comment, or the prompt. */
  text: string
  /** AgentActivityWebhookPayload.signal — "stop" when the person hit Stop in the session. */
  signal: string
  /** The Linear comment behind this prompt (a session message is also a comment in the thread). */
  promptCommentId: string
  promptContext: string
  trigger: 'delegated' | 'mentioned'
}

function parseSessionEvent(payload: unknown): SessionEvent | null {
  const sessionId = firstStr(payload, 'agentSession.id')
  if (!sessionId) return null
  const issueId = firstStr(payload, 'agentSession.issue.id', 'agentSession.issueId')
  // Linear says whether the session started from an assignment or a mention
  // in a couple of shapes; default to "mentioned", the conservative one.
  const rawTrigger = firstStr(payload, 'agentSession.type', 'agentSession.trigger', 'trigger').toLowerCase()
  const trigger: SessionEvent['trigger'] =
    rawTrigger.includes('deleg') || rawTrigger.includes('assign') ? 'delegated' : 'mentioned'
  return {
    action: firstStr(payload, 'action'),
    orgId: firstStr(payload, 'organizationId'),
    sessionId,
    issue: {
      id: issueId,
      identifier: firstStr(payload, 'agentSession.issue.identifier'),
      title: firstStr(payload, 'agentSession.issue.title'),
      description: firstStr(payload, 'agentSession.issue.description'),
      url: firstStr(payload, 'agentSession.issue.url'),
      teamId: firstStr(payload, 'agentSession.issue.team.id', 'agentSession.issue.teamId'),
      projectId: firstStr(payload, 'agentSession.issue.project.id', 'agentSession.issue.projectId'),
      priority: Number(pick(payload, 'agentSession.issue.priority') ?? 0) || 0,
    },
    // AgentActivityWebhookPayload.user / AgentSessionWebhookPayload.creator
    // (the latter unset for sessions opened by automation or the app user).
    creatorName: firstStr(payload, 'agentActivity.user.name', 'agentSession.creator.name', 'actor.name'),
    commentId: firstStr(payload, 'agentSession.commentId', 'agentSession.comment.id'),
    // AgentActivityWebhookPayload.content is the activity JSON ({ type: 'prompt', body }).
    text: firstStr(payload, 'agentActivity.content.body', 'agentActivity.body', 'agentSession.comment.body', 'comment.body'),
    signal: firstStr(payload, 'agentActivity.signal').toLowerCase(),
    promptCommentId: firstStr(payload, 'agentActivity.sourceCommentId'),
    promptContext: firstStr(payload, 'promptContext', 'agentSession.promptContext'),
    trigger,
  }
}

async function ack(orgId: string, sessionId: string, body: string, ephemeral = true): Promise<void> {
  try {
    await createAgentActivity(orgId, sessionId, { type: 'thought', body }, ephemeral)
  } catch (err) {
    console.warn('[Surfaces] linear ack failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Ends the session's turn with an answer. Used when nothing will run on this
 * machine right now: a session left on a thought looks stuck to Linear, a
 * response closes it cleanly, and the agent's activities reopen it later.
 */
async function sessionResponse(orgId: string, sessionId: string, body: string): Promise<void> {
  try {
    await createAgentActivity(orgId, sessionId, { type: 'response', body })
  } catch (err) {
    console.warn('[Surfaces] linear response activity failed:', err instanceof Error ? err.message : err)
  }
}

async function sessionError(orgId: string, sessionId: string, body: string): Promise<void> {
  try {
    await createAgentActivity(orgId, sessionId, { type: 'error', body })
  } catch (err) {
    console.warn('[Surfaces] linear error activity failed:', err instanceof Error ? err.message : err)
  }
}

function firstPrompt(ev: SessionEvent, issue: SessionEvent['issue'], nodeLabel: string): string {
  const heading = [issue.identifier, issue.title].filter(Boolean).join(' ')
  const who = ev.creatorName || 'Linear'
  const how =
    ev.trigger === 'delegated'
      ? `You were **delegated** this Linear issue by ${who}: implement it.`
      : `You were **mentioned** on this Linear issue by ${who}: read it and answer; do not change code until asked.`
  const parts = [`From ${who} on Linear (${ev.trigger}) — ${heading}${issue.url ? `\n${issue.url}` : ''}\n${how}\n(Running on ${nodeLabel}.)`]
  if (issue.description) parts.push(issue.description)
  if (ev.promptContext) parts.push(ev.promptContext.trim())
  if (ev.text.trim() && ev.text.trim() !== ev.promptContext.trim()) {
    parts.push(`The comment that brought you in, from ${who}:\n\n${ev.text.trim()}`)
  }
  return parts.join('\n\n---\n\n')
}

export async function handleLinearEvent(storage: Storage, meta: InboundMeta, payload: unknown): Promise<void> {
  if (meta.event === 'Issue') return handleIssueEvent(payload)
  if (meta.event === 'Comment') return handleCommentEvent(storage, meta, payload)
  if (meta.event !== 'AgentSessionEvent') return
  const ev = parseSessionEvent(payload)
  if (!ev) return
  const local = getLinearAppConfig()
  const orgId = ev.orgId || local?.orgId || ''
  if (!orgId) {
    console.warn('[Surfaces] linear event without org; is Linear connected on this machine?')
    return
  }
  if (ev.action === 'created') return onSessionCreated(storage, meta, ev, orgId)
  if (ev.action === 'prompted') return onSessionPrompted(storage, meta, ev, orgId)
}

async function onSessionCreated(storage: Storage, meta: InboundMeta, ev: SessionEvent, orgId: string): Promise<void> {
  const nodeLabel = getSaasConfig().label ?? 'this machine'
  // 10-second line: a sign of life before anything else (design §8.1 step 3).
  await ack(orgId, ev.sessionId, `Picked up on ${nodeLabel}. Reading the issue…`)

  // The webhook carries a slice of the issue; the labels (which name the
  // repository) and often the description only come from a read.
  let issue = ev.issue
  let labels: string[] = []
  if (issue.id) {
    try {
      const full = await fetchLinearIssue(orgId, issue.id)
      issue = {
        id: full.id,
        identifier: full.identifier,
        title: full.title,
        description: full.description ?? '',
        url: full.url,
        teamId: full.teamId ?? '',
        projectId: full.projectId ?? '',
        priority: full.priority,
      }
      labels = full.labels
    } catch (err) {
      console.warn('[Surfaces] could not read issue', issue.id, err instanceof Error ? err.message : err)
    }
  }

  const attachSession = (task: Task) => {
    storage.taskSurfaceUpsert({
      taskId: task.id,
      kind: 'linear_session',
      externalId: ev.sessionId,
      url: issue.url || null,
      meta: {
        orgId,
        issueId: issue.id,
        identifier: issue.identifier,
        commentId: ev.commentId,
        state: 'active',
        trigger: ev.trigger,
        creator: ev.creatorName,
      },
    })
    const where = issue.identifier || 'a Linear issue'
    storage.taskAppendActivity(task.id, {
      kind: 'system',
      actorType: 'system',
      actorName: 'system',
      body: ev.creatorName
        ? `${ev.creatorName} ${ev.trigger === 'delegated' ? 'delegated' : 'mentioned the agent on'} ${where}`
        : `Linear opened an agent session on ${where}`,
      meta: {
        event: ev.creatorName
          ? ev.trigger === 'delegated' ? 'linear.delegated' : 'linear.mentioned'
          : 'linear.sessionOpened',
        creator: ev.creatorName,
        where,
        source: 'linear_session',
        sessionId: ev.sessionId,
        actor: meta.actor,
        routeReason: meta.routeReason,
      },
    })
    broadcastTask(storage, task.id)
    setReplyTarget(task.id, { kind: 'linear_session', ref: ev.sessionId })
  }

  // Already a task here (published from the desktop, or delegated before):
  // attach the session so progress and questions flow to it, and stop. The
  // desktop decides when the agent runs.
  const existingSurface = issue.id ? storage.taskSurfaceFind('linear_issue', issue.id) : null
  const existing = existingSurface ? storage.taskGet(existingSurface.taskId) : null
  if (existing) {
    attachSession(existing)
    if (existing.bindingId != null) {
      // Running: its next activities land here; a thought is enough.
      await ack(orgId, ev.sessionId, `Attached to operon task #${existing.number}; the agent is already working on it.`, false)
    } else {
      await sessionResponse(
        orgId,
        ev.sessionId,
        `Attached to operon task #${existing.number}. It is not running yet — start it from operon on ${nodeLabel} and this session will pick up from there.`,
      )
    }
    return
  }

  if (!issue.id) {
    await sessionError(orgId, ev.sessionId, 'This session has no issue attached; operon only works from issues.')
    return
  }
  const picked = repoFromLabels(labels)
  if ('error' in picked) {
    const why =
      picked.error === 'none'
        ? `This issue does not say which repository it is about. Add a label \`${REPO_LABEL_PREFIX}owner/name\` (the GitHub repository) and delegate again.`
        : picked.error === 'ambiguous'
          ? `This issue names more than one repository (${picked.labels.join(', ')}). Keep one \`${REPO_LABEL_PREFIX}\` label and delegate again.`
          : `The repository label must be \`${REPO_LABEL_PREFIX}owner/name\` (got ${picked.labels.join(', ')}). Fix it and delegate again.`
    await sessionError(orgId, ev.sessionId, why)
    return
  }
  const project = await findProjectByRepo(picked.repo)
  if (!project) {
    await sessionError(
      orgId,
      ev.sessionId,
      `No checkout of ${picked.repo} is open in operon on ${nodeLabel}. Open that repository there (or fix the \`${REPO_LABEL_PREFIX}\` label) and delegate again.`,
    )
    return
  }

  // The task mirrors the issue field for field (title / description /
  // priority sync both ways); Linear's promptContext rides in the brief
  // comment below, not in the description, or it would be written back.
  const agentId = getLinearDelegationConfig().defaultAgentId
  const agent = agentId != null ? storage.getAgent(agentId) : null
  const task = storage.taskCreate({
    projectId: project.id,
    title: issue.title || issue.identifier || 'Linear issue',
    description: issue.description || undefined,
    priority: fromLinearPriority(issue.priority),
    assignedAgentId: agent?.id ?? null,
    createdBy: 'human',
  })
  storage.taskSurfaceUpsert({
    taskId: task.id,
    kind: 'linear_issue',
    externalId: issue.id,
    url: issue.url || null,
    meta: {
      identifier: issue.identifier,
      orgId,
      teamId: issue.teamId,
      projectId: issue.projectId,
      synced: { status: task.status, title: task.title, description: task.description ?? '', priority: task.priority },
      syncedStatus: task.status,
    },
  })
  attachSession(task)

  if (meta.routeReason === 'installer' && meta.actor !== 'owner') {
    await ack(
      orgId,
      ev.sessionId,
      `${ev.creatorName || 'The person who delegated this'} hasn't linked their Linear account to operon yet, so this landed on the installer's machine (${nodeLabel}). Link it in operon → Settings → Linear to route to your own.`,
    )
  }

  // The Linear brief goes in as a comment BEFORE dispatch: the dispatch prompt
  // makes the agent read the task (and its comments) first, so the brief is
  // seen without racing a second wake against the session dispatch is starting.
  storage.taskAppendActivity(task.id, {
    kind: 'comment',
    actorType: 'human',
    actorName: ev.creatorName || 'Linear',
    body: firstPrompt(ev, issue, nodeLabel),
    meta: { source: 'linear_session', sessionId: ev.sessionId, actor: meta.actor, brief: true },
  })
  if (!agent) {
    await sessionResponse(
      orgId,
      ev.sessionId,
      `Created operon task #${task.number} in ${project.name} on ${nodeLabel}. No default agent is set for Linear delegations there, so it is waiting for someone to start it in operon; this session will pick up from there.`,
    )
    return
  }
  try {
    await dispatchProjectTask(task.id, agent.id)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await sessionError(orgId, ev.sessionId, `Could not start on ${nodeLabel}: ${msg}`)
  }
}

// Comment ids behind session prompts seen recently. Linear also delivers each
// session message as a Comment webhook (a child of the session's root comment);
// this catches the ones that arrive before the root comment id is on record.
const sessionPromptComments = new Set<string>()

async function onSessionPrompted(storage: Storage, meta: InboundMeta, ev: SessionEvent, orgId: string): Promise<void> {
  const surface = storage.taskSurfaceFind('linear_session', ev.sessionId)
  const task = surface ? storage.taskGet(surface.taskId) : null
  if (!task) {
    await sessionError(orgId, ev.sessionId, 'This session is unknown on this machine. Delegate the issue again to start over.')
    return
  }
  if (ev.promptCommentId) {
    sessionPromptComments.add(ev.promptCommentId)
    if (sessionPromptComments.size > 500) sessionPromptComments.delete(sessionPromptComments.values().next().value as string)
  }
  // Sessions attached before the root comment id was recorded learn it here.
  if (ev.commentId && surface && surface.meta?.commentId !== ev.commentId) {
    storage.taskSurfaceUpsert({ taskId: task.id, kind: 'linear_session', externalId: ev.sessionId, meta: { commentId: ev.commentId } })
  }
  const text = ev.text.trim()
  // Only the task's owner steers the agent (design §8.5); everyone else is
  // recorded and acknowledged.
  if (meta.actor !== 'owner') {
    if (!text) return
    recordNonOwnerComment(task.id, 'linear_session', ev.creatorName || 'someone on Linear', text, { sessionId: ev.sessionId })
    broadcastTask(storage, task.id)
    const owner = getLinearAppConfig()?.linearUserName ?? 'the task owner'
    await ack(orgId, ev.sessionId, `Noted. Waiting for ${owner} to pick this up.`)
    return
  }
  setReplyTarget(task.id, { kind: 'linear_session', ref: ev.sessionId })

  // Stop is a control, not a message: interrupt the turn and say so.
  if (ev.signal === 'stop') {
    const binding = task.bindingId != null ? storage.getBinding(task.bindingId) : null
    const chatId = binding?.activeChatId ?? null
    const stopped = chatId != null && abortChat(chatId)
    await sessionResponse(orgId, ev.sessionId, stopped ? 'Stopped.' : 'Nothing was running.')
    return
  }
  if (!text) return
  // The session thread is the conversation; it is not mirrored into the task's
  // activity feed (the person asked for exactly that), only handed to the agent.
  await ack(orgId, ev.sessionId, 'Reading your reply…')

  const pending = storage.surfacePendingListByTask(task.id)
  if (pending.length > 0) {
    let resolved = 0
    for (const a of answersFor(pending, text)) {
      if (handlePermissionResponse(a.approvalId, a.outcome, a.chatId)) resolved += 1
      storage.surfacePendingDelete(a.approvalId)
    }
    if (resolved > 0) return
  }
  if (task.bindingId == null) {
    await sessionError(orgId, ev.sessionId, 'The agent session on this machine has ended. Delegate the issue again to start over.')
    return
  }
  await wakeTaskBinding(task.bindingId, `From ${ev.creatorName || 'the task owner'} on Linear:\n\n${text}`)
}

// Issue field changes → task (surface-sync.ts decides echo vs. real change).
async function handleIssueEvent(payload: unknown): Promise<void> {
  const issueId = firstStr(payload, 'data.id')
  if (!issueId) return
  const action = firstStr(payload, 'action')
  if (action !== 'update' && action !== 'remove') return
  const updatedFrom = pick(payload, 'updatedFrom')
  const changed = updatedFrom && typeof updatedFrom === 'object' ? Object.keys(updatedFrom as Record<string, unknown>) : []
  const priorityRaw = pick(payload, 'data.priority')
  const stateId = firstStr(payload, 'data.state.id', 'data.stateId')
  const assigneeRaw = pick(payload, 'data.assigneeId')
  const assigneeId = assigneeRaw === null ? null : firstStr(payload, 'data.assigneeId', 'data.assignee.id') || undefined
  await applyIssueChange({
    issueId,
    actorName: firstStr(payload, 'actor.name') || 'Linear',
    title: firstStr(payload, 'data.title') || undefined,
    description: typeof pick(payload, 'data.description') === 'string' ? (pick(payload, 'data.description') as string) : undefined,
    priority: typeof priorityRaw === 'number' ? priorityRaw : undefined,
    state: stateId ? { id: stateId, name: firstStr(payload, 'data.state.name'), type: firstStr(payload, 'data.state.type') } : undefined,
    assigneeId: action === 'remove' ? null : assigneeId,
    changed: action === 'remove' ? ['assigneeId'] : changed,
  })
}

// A plain comment on the issue (not an agent-session reply, which arrives as
// AgentSessionEvent prompted) → activity feed. Never wakes the agent: the
// session thread is for steering; issue comments are notes.
async function handleCommentEvent(storage: Storage, meta: InboundMeta, payload: unknown): Promise<void> {
  if (firstStr(payload, 'action') !== 'create') return
  const commentId = firstStr(payload, 'data.id')
  if (commentId && isMirroredComment(commentId)) return
  const issueId = firstStr(payload, 'data.issueId', 'data.issue.id')
  const body = firstStr(payload, 'data.body')
  if (!issueId || !body.trim()) return
  // A reply inside an agent session's thread is a child of the session's root
  // comment (CommentWebhookPayload.parentId). Those reach the agent as the
  // session's `prompted` event; recording them here too would double them up
  // as plain notes. The root comment itself is the agent's own thread.
  const parentId = firstStr(payload, 'data.parentId', 'data.parent.id')
  if (sessionPromptComments.has(commentId)) return
  if (isSessionThreadComment(storage, issueId, commentId, parentId)) return
  const appUserId = getLinearAppConfig()?.appUserId
  const authorId = firstStr(payload, 'data.userId', 'data.user.id')
  if (appUserId && authorId === appUserId) return // our own mirror, seen from another angle
  recordLinearComment({
    issueId,
    commentId,
    authorName: firstStr(payload, 'data.user.name', 'actor.name') || 'someone on Linear',
    body: body.trim(),
    actor: meta.actor,
  })
}

function isSessionThreadComment(storage: Storage, issueId: string, commentId: string, parentId: string): boolean {
  const issueSurface = storage.taskSurfaceFind('linear_issue', issueId)
  if (!issueSurface) return false
  return storage.taskSurfaceList(issueSurface.taskId).some((s) => {
    if (s.kind !== 'linear_session') return false
    const root = typeof s.meta?.commentId === 'string' ? s.meta.commentId : ''
    return root !== '' && (root === parentId || root === commentId)
  })
}
