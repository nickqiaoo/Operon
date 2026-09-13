import type { RuntimeTextStreamPart } from '@operon/agent-runtime'
import type { TaskStorageAdapter } from '../../storage/interface.js'
import type { SurfacePending, TaskSurface } from '../../types/task.js'
import { getLinearAppConfig } from '../../services/integration-config.js'
import { parseRepoFull } from '../../services/integrations/github-app.js'
import { notify } from '../../services/notification-service.js'
import type { NotificationStorageAdapter } from '../../storage/interface.js'
import { renderPending } from './answers.js'
import {
  GitHubSurface,
  LinearSurface,
  hintOf,
  pullRequestUrlIn,
  resultTextOf,
  truncate,
  type GitHubReplyTarget,
  type Surface,
  type ToolTrace,
} from './surfaces.js'

// The task ↔ surface bridge (docs/linear-github/design.md §9): folds the task
// agent's stream into calls on the surfaces the task has, and remembers where
// the current turn came from so the reply goes back there.

type Storage = TaskStorageAdapter & NotificationStorageAdapter

let _storage: Storage | null = null

export function initTaskSurfaceBridge(storage: Storage): void {
  _storage = storage
}

function storage(): Storage {
  if (!_storage) throw new Error('task surface bridge not initialised')
  return _storage
}

export interface ReplyTarget {
  kind: 'linear_session' | 'github_pr'
  ref: string
  github?: GitHubReplyTarget
}

// Per task: which side spoke last (the reply goes there) and the live surface
// objects (GitHub's accumulates a trace across the turn, so it must persist).
interface TaskBridgeState {
  target: ReplyTarget | null
  linear: Map<string, LinearSurface>
  github: Map<string, GitHubSurface>
}

const states = new Map<number, TaskBridgeState>()

function stateOf(taskId: number): TaskBridgeState {
  let s = states.get(taskId)
  if (!s) {
    s = { target: null, linear: new Map(), github: new Map() }
    states.set(taskId, s)
  }
  return s
}

export function setReplyTarget(taskId: number, target: ReplyTarget): void {
  const s = stateOf(taskId)
  s.target = target
  if (target.kind === 'github_pr' && target.github) {
    s.github.get(target.ref)?.setTarget(target.github)
  }
}

// Surface rows are read on every stream part (text deltas arrive by the
// thousand), so the lookup is memoized for a second per task. A surface that
// attaches mid-session (desktop dispatch first, Linear session later) is
// picked up within that second.
const surfaceRowCache = new Map<number, { rows: TaskSurface[]; expiresAt: number }>()

function surfaceRows(taskId: number): TaskSurface[] {
  const hit = surfaceRowCache.get(taskId)
  if (hit && hit.expiresAt > Date.now()) return hit.rows
  const rows = storage().taskSurfaceList(taskId)
  surfaceRowCache.set(taskId, { rows, expiresAt: Date.now() + 1000 })
  return rows
}

export function invalidateSurfaceCache(taskId: number): void {
  surfaceRowCache.delete(taskId)
}

export function taskHasSurfaces(taskId: number): boolean {
  return surfaceRows(taskId).length > 0
}

function surfaceObject(taskId: number, row: TaskSurface): Surface | null {
  const s = stateOf(taskId)
  if (row.kind === 'linear_session') {
    const orgId = (row.meta?.orgId as string | undefined) ?? getLinearAppConfig()?.orgId
    if (!orgId) return null
    let obj = s.linear.get(row.externalId)
    if (!obj) {
      obj = new LinearSurface(orgId, row.externalId)
      s.linear.set(row.externalId, obj)
    }
    return obj
  }
  if (row.kind === 'github_pr') {
    const m = /^(.+)#(\d+)$/.exec(row.externalId)
    const repo = m ? parseRepoFull(m[1]!) : null
    if (!m || !repo) return null
    let obj = s.github.get(row.externalId)
    if (!obj) {
      obj = new GitHubSurface(repo, Number(m[2]), s.target?.kind === 'github_pr' && s.target.ref === row.externalId ? s.target.github ?? {} : {})
      s.github.set(row.externalId, obj)
    }
    return obj
  }
  return null
}

/** All live surfaces for a task (issues are not surfaces you can speak on). */
export function liveSurfaces(taskId: number): Surface[] {
  const out: Surface[] = []
  for (const row of surfaceRows(taskId)) {
    if (row.kind === 'linear_issue') continue
    if (row.kind === 'linear_session' && row.meta?.state === 'complete') continue
    const obj = surfaceObject(taskId, row)
    if (obj) out.push(obj)
  }
  return out
}

/** The surface the current turn answers on: the one that spoke last, else the newest live one. */
export function primarySurface(taskId: number): Surface | null {
  const all = liveSurfaces(taskId)
  const target = stateOf(taskId).target
  if (target) {
    const hit = all.find((s) => s.kind === target.kind && s.ref === target.ref)
    if (hit) return hit
  }
  return all[all.length - 1] ?? null
}

function swallow(p: Promise<unknown>, what: string): void {
  p.catch((err) => console.warn(`[Surfaces] ${what} failed:`, err instanceof Error ? err.message : err))
}

// ---- stream observer ----

interface TurnState {
  buffer: string
  calls: Map<string, ToolTrace>
  linked?: string
  sawTool: boolean
}

const turns = new Map<number, TurnState>() // chatId → turn

function turnOf(chatId: number): TurnState {
  let t = turns.get(chatId)
  if (!t) {
    t = { buffer: '', calls: new Map(), sawTool: false }
    turns.set(chatId, t)
  }
  return t
}

/**
 * Called for every part of a task agent's stream (agent-orchestrator's
 * drainAgentChat). Text before a tool call is a thought; text at the end is
 * the response; a tool-approval-request pauses the turn on the surface.
 */
export function observeTaskChatPart(taskId: number, chatId: number, part: RuntimeTextStreamPart): void {
  const primary = primarySurface(taskId)
  if (!primary) return
  const others = liveSurfaces(taskId).filter((s) => s !== primary)
  const turn = turnOf(chatId)
  const p = part as unknown as Record<string, unknown>

  switch (p.type) {
    case 'text-delta': {
      const text = typeof p.text === 'string' ? p.text : typeof p.delta === 'string' ? p.delta : ''
      turn.buffer += text
      break
    }
    case 'tool-call': {
      if (turn.buffer.trim()) {
        const text = turn.buffer.trim()
        turn.buffer = ''
        swallow(primary.thought(text), 'thought')
      }
      turn.sawTool = true
      const call: ToolTrace = {
        id: String(p.toolCallId),
        name: String(p.toolName),
        hint: hintOf(p.input),
        status: 'running',
      }
      turn.calls.set(call.id, call)
      swallow(primary.action(call), 'action')
      break
    }
    case 'tool-result':
    case 'tool-error': {
      const started = turn.calls.get(String(p.toolCallId))
      const isError = p.type === 'tool-error'
      const text = isError
        ? p.error instanceof Error
          ? p.error.message
          : String(p.error ?? 'failed')
        : resultTextOf(p.output)
      const call: ToolTrace = {
        id: String(p.toolCallId),
        name: started?.name ?? String(p.toolName ?? 'tool'),
        hint: started?.hint ?? '',
        status: isError ? 'error' : 'done',
        result: truncate(text, 400),
      }
      turn.calls.set(call.id, call)
      swallow(primary.action(call), 'action')
      // The PR tool names the PR it opened; link it as soon as it exists.
      if (!isError && call.name.endsWith('submit_pull_request')) {
        const url = pullRequestUrlIn(text)
        if (url && url !== turn.linked) {
          turn.linked = url
          for (const s of [primary, ...others]) swallow(s.link('Pull request', url), 'link')
        }
      }
      break
    }
    case 'tool-approval-request': {
      const toolCall = p.toolCall as { toolName?: string; input?: unknown } | undefined
      const approvalId = String(p.approvalId)
      const toolName = toolCall?.toolName ?? 'tool'
      const input =
        toolCall?.input && typeof toolCall.input === 'object' ? (toolCall.input as Record<string, unknown>) : {}
      const pending: SurfacePending = {
        approvalId,
        taskId,
        chatId,
        surfaceKind: primary.kind,
        surfaceRef: primary.ref,
        toolName,
        input,
        createdAt: Date.now(),
      }
      storage().surfacePendingUpsert(pending)
      const all = storage().surfacePendingListByTask(taskId)
      if (turn.buffer.trim()) {
        const text = turn.buffer.trim()
        turn.buffer = ''
        swallow(primary.thought(text), 'thought')
      }
      swallow(primary.ask(renderPending(all)), 'ask')
      for (const s of others) swallow(s.thought(`Waiting for a reply on ${primary.kind === 'linear_session' ? 'Linear' : 'GitHub'}.`), 'thought')
      const task = storage().taskGet(taskId)
      if (task) {
        storage().taskAppendActivity(taskId, {
          kind: 'system',
          actorType: 'system',
          actorName: 'system',
          body: `Waiting for a reply on ${primary.kind === 'linear_session' ? 'Linear' : 'GitHub'} (${toolName})`,
          meta: { source: primary.kind, approvalId },
        })
      }
      break
    }
    case 'error': {
      const msg = p.error instanceof Error ? p.error.message : String(p.error ?? 'Unknown error')
      turn.buffer = ''
      swallow(primary.error(`Something went wrong on my side: ${truncate(msg, 300)}`), 'error')
      break
    }
    case 'abort': {
      turn.buffer = ''
      swallow(primary.error('I was stopped before finishing.'), 'error')
      turns.delete(chatId)
      break
    }
    case 'finish': {
      const text = turn.buffer.trim()
      turn.buffer = ''
      if (text) {
        swallow(primary.respond(text), 'respond')
        const url = pullRequestUrlIn(text)
        if (url && url !== turn.linked) {
          turn.linked = url
          for (const s of [primary, ...others]) swallow(s.link('Pull request', url), 'link')
        }
        // The other side sees one line, not the whole reply (design §9).
        for (const s of others) {
          swallow(
            s.thought(`Replied on ${primary.kind === 'linear_session' ? 'Linear' : 'GitHub'}: ${truncate(text.replace(/\s+/g, ' '), 140)}`),
            'thought',
          )
        }
      }
      for (const s of [primary, ...others]) {
        if (s instanceof LinearSurface || s instanceof GitHubSurface) s.resetTurn()
      }
      turns.delete(chatId)
      break
    }
    default:
      break
  }
}

/** A pending question was answered elsewhere (desktop, or the other surface). */
export function clearPendingForChat(chatId: number): void {
  storage().surfacePendingDeleteByChat(chatId)
}

/** Post a plain line to every live surface (system notices, cancellations). */
export function announceToSurfaces(taskId: number, text: string, kind: 'thought' | 'error' = 'thought'): void {
  for (const s of liveSurfaces(taskId)) {
    swallow(kind === 'error' ? s.error(text) : s.thought(text), kind)
  }
}

/**
 * A comment from someone who is not the task's owner (design §8.5): recorded,
 * the owner is told, the agent is not woken.
 */
export function recordNonOwnerComment(
  taskId: number,
  source: 'linear_session' | 'github_pr',
  authorName: string,
  body: string,
  meta: Record<string, unknown>,
): void {
  const st = storage()
  const task = st.taskGet(taskId)
  if (!task) return
  st.taskAppendActivity(taskId, {
    kind: 'comment',
    actorType: 'human',
    actorName: authorName,
    body,
    meta: { ...meta, source, actor: 'other' },
  })
  notify(st, {
    kind: 'task_in_review',
    severity: 'action',
    sourceKey: `task:${task.id}:surface`,
    title: `${authorName} commented on #${task.number}`,
    body: truncate(body.replace(/\s+/g, ' '), 140),
    projectId: task.projectId,
    taskId: task.id,
  })
}

/** The session-instruction block for a task that has surfaces (design §12). */
export const SURFACE_PROMPT = `## Working in the open

People see you in two places: the Linear issue thread (an agent session) and pull request comments on GitHub. Messages from both reach you here, in one continuous conversation, each prefixed with who said it and where ("From X on Linear", "From @y on GitHub pull request #12 …").

- The first message says whether you were **mentioned** (discuss, read code, propose — do not change code until asked) or **delegated** (implement).
- When something ambiguous changes what you would build, ask once with AskUserQuestion and cover everything you need; the reply arrives as prose, not option picks.
- To ship: commit on your task branch, then call submit_pull_request with a title, a body (what changed and why, how it was tested, the Linear issue URL), and the branch. It pushes and opens the PR, or pushes to the PR already open for the branch. Do not run git push yourself — the working tree carries no credentials.
- Review follow-ups: change on the same branch, commit, call submit_pull_request again; your reply is posted where the comment was made, so answer the reviewer directly and briefly.
- Your final text each turn is posted to Linear / GitHub as your reply: standard markdown, short paragraphs, code in fences, no preamble, no restating the request. Use comment_project_task for progress notes that are not a reply — don't write the same sentence in both.`
