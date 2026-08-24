// Spec-Driven Development (SDD) service.
//
// Storage model (§5): the canonical artifact is a git file on the change branch;
// the DB (task_artifacts) holds only gate state plus content_ref and content_sha.
// This module carries the service logic for the promote / write / approve chain;
// the gate itself (assertGateOrThrow) is implemented separately in §6.

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { ArtifactKind, Task, TaskArtifact, TaskStatus } from '../../types/task.js'
import type { Agent } from '../../types/channel.js'
import type {
  ChannelStorageAdapter,
  ProjectStorageAdapter,
  TaskStorageAdapter,
} from '../../storage/interface.js'
import {
  worktreeAdd,
  getDefaultBaseBranch,
  commit,
  mergeBranch,
  gitShow,
} from '../git.js'
import { worktreePathFor } from '../worktree-paths.js'
import { ensureTeamNamed } from '../task-team.js'
import { splitPlanTaskText } from '@shared/taskboard/plan-task'

/** What promote/write/approve need from storage — spans channel/project/task adapters. */
export type SddStorage = ChannelStorageAdapter & ProjectStorageAdapter & TaskStorageAdapter

/** Change branch name for a task — change-scoped, survives author→executor handoff (§5.3). */
export function changeBranchName(taskNumber: number): string {
  return `operon/task-${taskNumber}`
}

/** Relative path (within the change-branch worktree) of an artifact file (§5.3). */
export function artifactRelPath(taskNumber: number, kind: ArtifactKind): string {
  const file =
    kind === 'spec'
      ? 'spec.md'
      : kind === 'plan'
        ? 'plan.md'
        : kind === 'acceptance'
          ? 'acceptance.md'
          : 'delta.md' // spec_delta
  return path.posix.join('.operon', 'changes', `task-${taskNumber}`, file)
}

/**
 * Per-task write serialization. The single-writer *ownership* lock was removed
 * (any agent may write spec/plan; a soft-warn from the write_artifact tool
 * nudges a caller who isn't the recorded author) — but write+commit still touch
 * a SHARED change-branch worktree, so two concurrent writes to the same task
 * must be serialized or git (index.lock contention / interleaved commits) can
 * corrupt the worktree. Chains promises per taskId; a failed write never blocks
 * the next waiter.
 */
const taskWriteChains = new Map<number, Promise<unknown>>()

function withTaskWriteLock<T>(taskId: number, fn: () => Promise<T>): Promise<T> {
  const prior = taskWriteChains.get(taskId) ?? Promise.resolve()
  const next = prior.then(fn, fn)
  taskWriteChains.set(
    taskId,
    next.catch(() => undefined),
  )
  return next
}

/** The name of the implicit, hidden spec author used for chat-sourced SDD tasks. */
export const WORKSPACE_ASSISTANT_NAME = 'Workspace Assistant'

/**
 * The implicit spec author for a chat-sourced SDD task. A direct workspace chat
 * is user ↔ CLI with no registered agent, but SDD records an agent as spec
 * author (provenance / soft-warn / dedup). One hidden, reusable agent per
 * install fills that role; it never executes — dispatch always picks a real
 * agent. Hidden so it never appears in user-facing agent pickers.
 */
export function getOrCreateWorkspaceAssistant(
  storage: SddStorage,
  fallback?: { provider?: string; model?: string },
): Agent {
  const existing = storage.getAgentByName(WORKSPACE_ASSISTANT_NAME)
  if (existing) return existing
  return storage.createAgent({
    name: WORKSPACE_ASSISTANT_NAME,
    provider: fallback?.provider ?? 'claude-code',
    model: fallback?.model ?? 'sonnet',
    instructions: '',
    hidden: true,
  })
}

/** Where a spec-driven task was promoted from — a channel discussion or a direct workspace chat. */
export type PromoteSource =
  | { kind: 'channel'; channelId: number; messageId?: number | null }
  | { kind: 'chat'; projectId: number; chatId: number }

export interface PromoteToTaskInput {
  source: PromoteSource
  /** The agent that holds the context and will author spec/plan (§2.2 / §5.4).
   *  For a chat source this is the implicit Workspace Assistant. */
  authorAgentId: number
  title: string
  description?: string
}

/**
 * Promote a converged channel discussion into an SDD parent task (§7, stage 2).
 *
 * Creates the parent task (todo, sdd_managed, spec_author = author), cuts the
 * change branch `operon/task-<N>` off the default base branch with a dedicated
 * worktree, and records the source channel/message. The author then writes
 * spec.md via writeArtifact (server commits into this worktree). Requires the
 * channel to have SDD enabled and the project to be a git repo.
 */
export async function promoteToTask(storage: SddStorage, input: PromoteToTaskInput): Promise<Task> {
  const { source } = input
  // Resolve target project + provenance from the (polymorphic) source. No source
  // "mode" gate: promote IS the action that turns a discussion into a spec-driven
  // change (§9, action-based). A channel derives its project; a direct chat carries
  // the project from the session (the chat's workspace).
  let projectId: number
  let sourceChannelId: number | null = null
  let sourceChatId: number | null = null
  let sourceMessageId: number | null = null
  if (source.kind === 'channel') {
    const channel = storage.getChannel(source.channelId)
    if (!channel) throw new Error(`Channel ${source.channelId} not found`)
    projectId = channel.projectId
    sourceChannelId = source.channelId
    sourceMessageId = source.messageId ?? null
  } else {
    projectId = source.projectId
    sourceChatId = source.chatId
  }
  const project = storage.getProject(projectId)
  if (!project) throw new Error(`Project ${projectId} not found`)
  const author = storage.getAgent(input.authorAgentId)
  if (!author) throw new Error(`Agent ${input.authorAgentId} not found`)

  // Dedup: if this SAME source already has an SDD change still being AUTHORED
  // (parent, status 'todo' = spec not yet signed, §15.1), a second promote is
  // almost always a duplicate — return the existing change instead of forking a
  // duplicate task + branch. Once a change is dispatched (in_progress) or
  // finished, a later promote is a genuinely new change.
  const inFlight = storage
    .taskList({ projectId, status: 'todo' })
    .find(
      (t) =>
        t.sddManaged &&
        t.parentTaskId == null &&
        (source.kind === 'channel'
          ? t.sourceChannelId === source.channelId
          : t.sourceChatId === source.chatId),
    )
  if (inFlight) return inFlight

  // 1. Parent task — sdd_managed, spec author recorded (§5.4).
  const task = storage.taskCreate({
    projectId,
    title: input.title,
    description: input.description ?? '',
    sddManaged: true,
    specAuthorAgentId: input.authorAgentId,
    sourceChannelId,
    sourceChatId,
    sourceMessageId,
    createdBy: 'agent',
    actorId: input.authorAgentId,
    actorName: author.name,
  })

  // 2. Change branch operon/task-<N> + dedicated worktree, based off main.
  const branchName = changeBranchName(task.number)
  const worktreePath = worktreePathFor(projectId, project.rootPath, `task-${task.number}`)
  const base = (await getDefaultBaseBranch(project.rootPath)) ?? undefined
  await fs.mkdir(path.dirname(worktreePath), { recursive: true })
  await worktreeAdd(project.rootPath, worktreePath, branchName, true, base)
  const workspace = storage.createWorkspace(projectId, {
    name: `SDD · task #${task.number}`,
    branchName,
    worktreePath,
  })

  // 3. Pin branch + workspace on the task.
  const updated = storage.taskUpdate(
    task.id,
    { branchName, workspaceId: workspace.id },
    { type: 'agent', id: input.authorAgentId, name: author.name },
  )

  // 4. Activity: change branch created.
  storage.taskAppendActivity(task.id, {
    kind: 'branch',
    actorType: 'agent',
    actorId: input.authorAgentId,
    actorName: author.name,
    body: `Created change branch \`${branchName}\` for spec authoring`,
    meta: { branch: branchName },
  })

  return updated ?? task
}

/** git blob object id of content — matches `git hash-object`, computed without spawning git. */
function gitBlobSha(content: string): string {
  const data = Buffer.from(content, 'utf8')
  const header = Buffer.from(`blob ${data.length}\0`, 'utf8')
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex')
}

/** Who is performing a write/approve. Humans (owner) bypass the single-writer lock (§5.4). */
export interface ArtifactActor {
  type: 'human' | 'agent'
  id: number | null
  name: string
}

export interface WriteArtifactInput {
  taskId: number
  kind: ArtifactKind
  content: string
  caller: ArtifactActor
}

/**
 * Write an artifact file into the task's change-branch worktree and commit it
 * (§7, stages 2 and 3). The single-writer *ownership* lock was removed (§5.4 revised):
 * any agent may write spec/plan; coordination is via prompt guidance + a
 * soft-warn (the taskboard write_artifact tool flags a caller who isn't the
 * recorded spec author). Concurrent writes to the same task's shared worktree
 * are made safe by per-task serialization (`withTaskWriteLock`), not exclusion.
 * A write always lands the artifact as `draft` (re-approval required), so an
 * overwrite of a signed spec is never silent; content_sha records the git blob
 * sha for drift detection (§5.5).
 */
export async function writeArtifact(
  storage: SddStorage,
  input: WriteArtifactInput,
): Promise<TaskArtifact> {
  const task = storage.taskGet(input.taskId)
  if (!task) throw new Error(`Task ${input.taskId} not found`)
  if (!task.sddManaged) throw new Error(`Task #${task.number} is not SDD-managed`)
  if (task.workspaceId == null) {
    throw new Error(`Task #${task.number} has no change-branch worktree (not promoted?)`)
  }
  const workspace = storage.getWorkspace(task.workspaceId)
  if (!workspace) throw new Error(`Workspace ${task.workspaceId} not found`)

  const relPath = artifactRelPath(task.number, input.kind)
  return withTaskWriteLock(task.id, async () => {
    const absPath = path.join(workspace.worktreePath, relPath)
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, input.content, 'utf8')
    await commit(workspace.worktreePath, `sdd(task #${task.number}): write ${input.kind}`, {
      includeUnstaged: true,
    })

    // A fresh write always lands as draft (needs re-approval) and clears prior signature.
    const artifact = storage.taskArtifactUpsert(task.id, input.kind, {
      status: 'draft',
      contentRef: relPath,
      contentSha: gitBlobSha(input.content),
      approvedByType: null,
      approvedBy: null,
      approvedAt: null,
    })
    storage.taskAppendActivity(task.id, {
      kind: 'system',
      actorType: input.caller.type,
      actorId: input.caller.id,
      actorName: input.caller.name,
      body: `Wrote ${input.kind} (\`${relPath}\`)`,
      meta: { artifactKind: input.kind, contentRef: relPath },
    })
    return artifact
  })
}

export interface ApproveArtifactInput {
  taskId: number
  kind: ArtifactKind
  approver: ArtifactActor
}

/**
 * Approve an artifact (§6 Gate-0/Gate-3 signing). Recomputes content_sha from
 * the file currently on the change branch, so the approved sha reflects exactly
 * what was signed; a later edit that changes the blob sha = drift (§5.5).
 */
export async function approveArtifact(
  storage: SddStorage,
  input: ApproveArtifactInput,
): Promise<TaskArtifact> {
  const task = storage.taskGet(input.taskId)
  if (!task) throw new Error(`Task ${input.taskId} not found`)
  const existing = storage.taskArtifactGet(task.id, input.kind)
  if (!existing || !existing.contentRef) {
    throw new Error(`Task #${task.number} has no written ${input.kind} to approve`)
  }
  if (task.workspaceId == null) throw new Error(`Task #${task.number} has no worktree`)
  const workspace = storage.getWorkspace(task.workspaceId)
  if (!workspace) throw new Error(`Workspace ${task.workspaceId} not found`)

  // Approved sha = sha of the file as it stands now on the change branch.
  const content = await fs.readFile(path.join(workspace.worktreePath, existing.contentRef), 'utf8')
  // Gate-0: a spec with unresolved [NEEDS CLARIFICATION] markers cannot be signed (§6/§7).
  if (input.kind === 'spec' && /\[NEEDS CLARIFICATION/i.test(content)) {
    throw new Error(
      `Cannot approve spec for task #${task.number}: unresolved [NEEDS CLARIFICATION] marker(s) remain`,
    )
  }
  const artifact = storage.taskArtifactUpsert(task.id, input.kind, {
    status: 'approved',
    approvedByType: input.approver.type,
    approvedBy: input.approver.id,
    approvedAt: Date.now(),
    contentSha: gitBlobSha(content),
  })
  storage.taskAppendActivity(task.id, {
    kind: 'system',
    actorType: input.approver.type,
    actorId: input.approver.id,
    actorName: input.approver.name,
    body: `Approved ${input.kind}`,
    meta: { artifactKind: input.kind },
  })
  return artifact
}

/** Read an artifact's current file content from the task's change-branch worktree (null if absent). */
export async function readArtifactContent(
  storage: SddStorage,
  task: Task,
  kind: ArtifactKind,
): Promise<string | null> {
  const a = storage.taskArtifactGet(task.id, kind)
  if (!a || !a.contentRef || task.workspaceId == null) return null
  const ws = storage.getWorkspace(task.workspaceId)
  if (!ws) return null
  try {
    return await fs.readFile(path.join(ws.worktreePath, a.contentRef), 'utf8')
  } catch {
    return null
  }
}

/**
 * Drift detection (§5.5): re-hash every approved artifact against the file
 * currently on the change branch; any whose blob sha no longer matches the
 * signed sha (or whose file vanished) is demoted back to `draft` and a
 * "re-sign needed" activity is recorded. Single-writer (§5.4) makes "who changed
 * it" unambiguous. Returns the artifacts that were demoted (empty = no drift).
 *
 * Run lazily at the read/gate boundaries (artifact list, status change, dispatch)
 * rather than via a long-running watcher — deterministic and race-free.
 */
export async function detectAndApplyDrift(
  storage: SddStorage,
  task: Task,
): Promise<TaskArtifact[]> {
  if (!task.sddManaged || task.workspaceId == null) return []
  const ws = storage.getWorkspace(task.workspaceId)
  if (!ws) return []
  const demoted: TaskArtifact[] = []
  for (const a of storage.taskArtifactList(task.id)) {
    if (a.status !== 'approved' || !a.contentRef) continue
    let currentSha: string | null = null
    try {
      const content = await fs.readFile(path.join(ws.worktreePath, a.contentRef), 'utf8')
      currentSha = gitBlobSha(content)
    } catch {
      currentSha = null // file gone → treat as drift
    }
    if (currentSha === a.contentSha) continue
    const updated = storage.taskArtifactUpsert(task.id, a.kind, {
      status: 'draft',
      approvedByType: null,
      approvedBy: null,
      approvedAt: null,
      ...(currentSha ? { contentSha: currentSha } : {}),
    })
    storage.taskAppendActivity(task.id, {
      kind: 'system',
      actorType: 'system',
      actorName: 'system',
      body: `${a.kind} changed after approval — re-sign needed`,
      meta: { artifactKind: a.kind, drift: true },
    })
    demoted.push(updated)
  }
  return demoted
}

// ---- Plan decomposition into child tasks (§7 stage 3 / §11.3 task-line contract) ----

/** One parsed task row from plan.md (the `[T###] [P?] [AC anchors] desc` contract, §11.3). */
export interface ParsedPlanTask {
  /** Stable anchor into plan.md, e.g. 'T012'. Becomes the child's plan_anchor (§4, work axis). */
  anchor: string
  /** `[P]` flag = parallelizable (no deps / disjoint files) → feeds the DAG engine. */
  parallel: boolean
  /**
   * `[C<n>]` coordination group, e.g. 'C1' — rows sharing one are dispatched into
   * a shared team inbox so their agents can reconcile a contract that is still
   * moving. null = works alone (the default; see SDD_WORKFLOW_PROMPT §3).
   * Distinct from `parallel`: `[P]` is about file conflicts, `[C]` is about
   * whether they need to talk.
   */
  coordGroup: string | null
  /** AC ids this row claims, e.g. ['AC-1','AC-3']. Becomes the child's claimed_acs (§4, acceptance axis). */
  claimedAcs: string[]
  /** Human-readable remainder (anchor + recognized tags stripped). */
  title: string
  /** Markdown instructions following an explicit bold title, if present. */
  description: string
}

/**
 * Parse plan.md task rows per the §11.3 contract: a row is a (optionally
 * bulleted/checkboxed) line carrying a `T###` anchor — bare (`T012 …`) or
 * bracketed (`[T012]`). `[P]` marks parallelizable; `[AC-n]` (one or many,
 * comma- or bracket-separated) are the claimed acceptance criteria. Lines with
 * no anchor (headers, prose, checkpoints) are skipped; duplicate anchors keep
 * the first.
 */
export function parsePlanTasks(planContent: string): ParsedPlanTask[] {
  const out: ParsedPlanTask[] = []
  const seen = new Set<string>()
  for (const raw of planContent.split('\n')) {
    const line = raw
      .replace(/^\s*[-*]\s*/, '') // list bullet
      .replace(/^\[[ xX]\]\s*/, '') // checkbox
      .trim()
    if (!line) continue

    // Anchor: a leading bare `T###`, or any `[T###]` bracket group.
    let anchor: string | null = null
    const bare = line.match(/^T(\d+)\b/)
    if (bare) anchor = `T${bare[1]}`

    const brackets = [...line.matchAll(/\[([^\]]*)\]/g)]
    let parallel = false
    let coordGroup: string | null = null
    const acs: string[] = []
    for (const b of brackets) {
      const inner = b[1].trim()
      if (/^P$/i.test(inner)) parallel = true
      const cm = inner.match(/^C(\d+)$/i)
      if (cm && !coordGroup) coordGroup = `C${cm[1]}`
      if (!anchor) {
        const t = inner.match(/^T(\d+)$/i)
        if (t) anchor = `T${t[1]}`
      }
      for (const m of inner.matchAll(/AC-(\d+)/gi)) acs.push(`AC-${m[1]}`)
    }
    if (!anchor || seen.has(anchor)) continue
    seen.add(anchor)

    const taskText =
      line
        .replace(/^T\d+\b/, '')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || anchor
    const { title, description } = splitPlanTaskText(taskText)
    out.push({
      anchor,
      parallel,
      coordGroup,
      claimedAcs: [...new Set(acs)],
      title,
      description,
    })
  }
  return out
}

/**
 * Group plan rows into execution waves (§11.3 scheduling contract).
 *
 * `[P]` means "I can run alongside my neighbours"; a row with neither `[P]` nor
 * `[C<n>]` is a barrier that runs alone. So concurrent rows collapse into one
 * wave and every plain row opens its own:
 *
 *   T001        →  wave 0  (barrier, runs alone)
 *   T002 [P]    ┐
 *   T003 [P]    ┘  wave 1  (both run together, after wave 0 finishes)
 *   T004        →  wave 2
 *
 * **`[C<n>]` implies `[P]`.** A coordination group only means anything while its
 * members are alive at the same time (they exist to talk mid-flight), so tagging
 * a row `[C1]` necessarily claims it runs concurrently — the author should not
 * have to write `[P] [C1]` and cannot express the contradiction of a group whose
 * members never overlap. That leaves three mutually exclusive row shapes: bare =
 * serial, `[P]` = concurrent, `[C<n>]` = concurrent + can message each other.
 *
 * This is what makes the prompt's promise true — "dependencies are solved by
 * ordering": a later wave's subtask branches are cut from the parent AFTER the
 * earlier wave merged into it, so it actually sees the earlier work.
 */
export function planWaves(tasks: ParsedPlanTask[]): string[][] {
  const waves: string[][] = []
  let openParallelWave = false
  for (const t of tasks) {
    const concurrent = t.parallel || t.coordGroup != null
    if (concurrent && openParallelWave) {
      waves[waves.length - 1].push(t.anchor)
    } else {
      waves.push([t.anchor])
      openParallelWave = concurrent
    }
  }
  return waves
}

/**
 * The subtasks that may be dispatched RIGHT NOW: everything still `todo` in the
 * earliest wave that hasn't fully settled (done/cancelled). Called at Dispatch
 * (first wave) and again after each child is marked Done (next wave).
 *
 * Children outside the plan — no anchor, or an anchor the current plan no longer
 * has — are not scheduled by anyone, so they ride along with the first live wave
 * rather than being stranded forever.
 *
 * Degrades to "everything at once" (the pre-scheduling behaviour) if the plan
 * can't be read, so an unreadable artifact never wedges a change.
 */
export async function nextDispatchableChildren(
  storage: SddStorage,
  parent: Task,
): Promise<Task[]> {
  const children = storage
    .taskListChildren(parent.id)
    .filter((c) => c.status !== 'cancelled')
  const pending = children.filter((c) => c.status === 'todo')
  if (pending.length === 0) return []

  const content = await readArtifactContent(storage, parent, 'plan')
  if (!content) return pending

  const waves = planWaves(parsePlanTasks(content))
  const scheduled = new Set(waves.flat())
  const byAnchor = new Map(
    children.filter((c) => c.planAnchor).map((c) => [c.planAnchor as string, c]),
  )
  // Unscheduled strays go out with the first wave that still has live work.
  const strays = pending.filter((c) => !c.planAnchor || !scheduled.has(c.planAnchor))

  for (const wave of waves) {
    const inWave = wave.map((a) => byAnchor.get(a)).filter((c): c is Task => !!c)
    if (inWave.length === 0) continue // plan row not decomposed yet
    if (inWave.every((c) => c.status === 'done')) continue // wave finished — look further
    return [...inWave.filter((c) => c.status === 'todo'), ...strays]
  }
  return strays
}

export interface DecomposeResult {
  created: Task[]
  /** Anchors that already had a child task (idempotent re-run). */
  skipped: string[]
}

/**
 * Decompose an SDD parent's approved plan.md into child tasks (§7, stage 3). Each
 * parsed task row becomes a child (parentTaskId = parent, plan_anchor + the AC
 * ids it claims). Requires the plan to be approved. Idempotent: rows whose
 * anchor already has a child are skipped, so it is safe to re-run after the plan
 * grows. Children carry no spec of their own — they inherit the parent's
 * spec/plan/AC (§4).
 */
export async function decomposePlan(
  storage: SddStorage,
  taskId: number,
  actor: ArtifactActor,
): Promise<DecomposeResult> {
  const parent = storage.taskGet(taskId)
  if (!parent) throw new Error(`Task ${taskId} not found`)
  if (!parent.sddManaged) throw new Error(`Task #${parent.number} is not SDD-managed`)
  if (parent.parentTaskId != null) {
    throw new Error(`Task #${parent.number} is a child task — decompose its parent instead`)
  }
  const plan = storage.taskArtifactGet(parent.id, 'plan')
  if (!plan || plan.status !== 'approved') {
    throw new Error(`Plan for task #${parent.number} must be written and approved before decomposing`)
  }
  const content = await readArtifactContent(storage, parent, 'plan')
  if (!content) throw new Error(`Plan for task #${parent.number} has no content on the change branch`)
  const parsed = parsePlanTasks(content)
  if (parsed.length === 0) {
    throw new Error(
      `No task rows found in plan for task #${parent.number} — each subtask needs a \`[T###]\` anchor line`,
    )
  }

  const existingAnchors = new Set(
    storage.taskListChildren(parent.id).map((c) => c.planAnchor).filter((a): a is string => !!a),
  )

  // Coordination teams (§11.3): a subtask only joins a team inbox when the plan
  // explicitly tagged it `[C<n>]`, and only if that group has ≥2 members — a
  // group of one has nobody to talk to. Un-grouped subtasks get no team, so
  // their agent sees an empty peer list rather than being tempted to ask around
  // (every peer message costs a real turn and can interrupt a running one).
  // Counted over the whole plan, not just newly-created rows, so re-running
  // decompose after adding a row still lands it in the right team.
  const groupMembers = new Map<string, ParsedPlanTask[]>()
  for (const item of parsed) {
    if (!item.coordGroup) continue
    const list = groupMembers.get(item.coordGroup) ?? []
    list.push(item)
    groupMembers.set(item.coordGroup, list)
  }
  // `[C<n>]` implies `[P]`, so a group's members normally share one wave. They can
  // still be split by a barrier row written between them — and members in different
  // waves are never alive at the same time, which makes the team worse than useless:
  // the earlier one sees no peers, and the later one can see (and wake) a sibling
  // that is already Done. Refuse to form such a group and say so.
  const waveOfAnchor = new Map<string, number>()
  planWaves(parsed).forEach((wave, i) => wave.forEach((a) => waveOfAnchor.set(a, i)))

  const teamIdByGroup = new Map<string, number>()
  for (const [group, members] of groupMembers) {
    if (members.length < 2) continue
    const waves = new Set(members.map((m) => waveOfAnchor.get(m.anchor)))
    if (waves.size > 1) {
      storage.taskAppendActivity(parent.id, {
        kind: 'system',
        actorType: 'system',
        actorName: 'system',
        body:
          `Coordination group ${group} was ignored: its rows (${members.map((m) => m.anchor).join(', ')}) ` +
          `land in different execution waves, so they never run at the same time. ` +
          `Remove the barrier row between them, or drop the ${group} tag.`,
        meta: { coordGroup: group, anchors: members.map((m) => m.anchor) },
      })
      continue
    }
    const base = parent.title.trim() || `Task #${parent.number}`
    teamIdByGroup.set(
      group,
      ensureTeamNamed(storage, parent.projectId, `${base.slice(0, 55)} · ${group}`),
    )
  }

  const created: Task[] = []
  const skipped: string[] = []
  for (const item of parsed) {
    if (existingAnchors.has(item.anchor)) {
      skipped.push(item.anchor)
      continue
    }
    const child = storage.taskCreate({
      projectId: parent.projectId,
      title: item.title,
      description: item.description,
      parentTaskId: parent.id,
      // Coordination group wins; otherwise inherit only an explicitly-set parent
      // team (promote never sets one, so in practice that means no team).
      teamId: (item.coordGroup ? teamIdByGroup.get(item.coordGroup) : undefined)
        ?? parent.teamId
        ?? undefined,
      sddManaged: true,
      planAnchor: item.anchor,
      claimedAcs: item.claimedAcs.length ? item.claimedAcs : null,
      createdBy: actor.type,
      actorId: actor.id,
      actorName: actor.name,
    })
    created.push(child)
  }

  if (created.length > 0) {
    const teamed = [...teamIdByGroup.keys()].sort()
    storage.taskAppendActivity(parent.id, {
      kind: 'system',
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      body:
        `Decomposed plan into ${created.length} subtask(s): ${created
          .map((c) => `#${c.number}`)
          .join(', ')}` +
        (teamed.length ? ` · coordination group(s): ${teamed.join(', ')}` : ''),
      meta: {
        decomposed: created.length,
        anchors: created.map((c) => c.planAnchor),
        coordGroups: teamed,
      },
    })
  }
  return { created, skipped }
}

// ---- Subtask merge: child change branch → parent change branch (§7 ⑤) ----

export interface MergeChildResult {
  parentTaskNumber: number
  mergedBranch: string
  sha: string
}

function isNothingToCommit(err: unknown): boolean {
  return /nothing to commit|no changes added to commit|working tree clean/i.test(
    err instanceof Error ? err.message : String(err),
  )
}

/**
 * Merge a finished SDD subtask's branch back into its parent change branch
 * (§7 ⑤). Any uncommitted work left in the child worktree is committed first so
 * the merge brings it in. Conflicts abort cleanly and surface a MergeConflictError
 * for a human to resolve (§17.4) — never auto-resolved. Records activity on both
 * tasks. Idempotent-ish: a re-run with nothing new is a no-op "already up to date"
 * (git returns success).
 */
export async function mergeChildIntoParent(
  storage: SddStorage,
  childTaskId: number,
  actor: ArtifactActor,
): Promise<MergeChildResult> {
  const child = storage.taskGet(childTaskId)
  if (!child) throw new Error(`Task ${childTaskId} not found`)
  if (!child.sddManaged || child.parentTaskId == null) {
    throw new Error(`Task #${child.number} is not an SDD subtask`)
  }
  if (!child.branchName) throw new Error(`Subtask #${child.number} has no branch to merge`)
  const parent = storage.taskGet(child.parentTaskId)
  if (!parent) throw new Error(`Parent task ${child.parentTaskId} not found`)
  if (parent.workspaceId == null) {
    throw new Error(`Parent #${parent.number} has no change-branch worktree`)
  }
  const parentWs = storage.getWorkspace(parent.workspaceId)
  if (!parentWs) throw new Error(`Parent workspace ${parent.workspaceId} not found`)

  // Commit any uncommitted work on the child branch first — the executing agent
  // edits files in the worktree but may not have committed (commit is a no-op /
  // throws "nothing to commit" when clean, which we swallow).
  if (child.workspaceId != null) {
    const childWs = storage.getWorkspace(child.workspaceId)
    if (childWs) {
      try {
        await commit(childWs.worktreePath, `sdd(task #${child.number}): finalize before merge`, {
          includeUnstaged: true,
        })
      } catch (err) {
        if (!isNothingToCommit(err)) throw err
      }
    }
  }

  const sha = await mergeBranch(
    parentWs.worktreePath,
    child.branchName,
    `Merge subtask #${child.number}${child.planAnchor ? ` (${child.planAnchor})` : ''} into ${parent.branchName}`,
  )

  storage.taskAppendActivity(parent.id, {
    kind: 'system',
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    body: `Merged subtask #${child.number} into \`${parent.branchName}\``,
    meta: { mergedBranch: child.branchName, sha },
  })
  storage.taskAppendActivity(child.id, {
    kind: 'system',
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    body: `Merged into parent \`${parent.branchName}\``,
    meta: { sha },
  })
  return { parentTaskNumber: parent.number, mergedBranch: child.branchName, sha }
}

// ---- AC coverage cross-check, reported when a plan is written (§8) ----

/** Collect stable `{#REQ-n}` / `{#AC-n}` anchor ids from artifact markdown (§11.3). */
function extractAnchorIds(content: string, prefix: 'REQ' | 'AC'): string[] {
  const ids = new Set<string>()
  for (const m of content.matchAll(new RegExp(`\\{#(${prefix}-\\d+)\\}`, 'gi'))) {
    ids.add(m[1].toUpperCase())
  }
  return [...ids]
}

/**
 * Cross-check a just-written plan against the spec's `{#AC-n}` anchors: every AC
 * the spec defines should be claimed by some plan row, and no row should claim an
 * id the spec never defined. Returned as warnings on the `write_artifact` result,
 * so the author is told in the same turn that caused the mismatch.
 *
 * This replaces the old `analyze_task` tool. That tool also checked plan↔subtask
 * structure, which cannot fail on its own: subtasks ARE decompose's output from
 * the plan's `[T###]` rows, so a mismatch only meant the plan changed and Dispatch
 * hadn't re-run — which Dispatch fixes by itself (routes/task.ts prepareSddParent
 * → decomposePlan skips existing anchors and adds new rows).
 *
 * What remains is deliberately not a gate. Both sides come from one authoring
 * pass, so this only catches an author contradicting itself (five AC defined,
 * three mentioned in the plan; a typo'd id). Passing costs one copied id and
 * proves nothing about whether the AC gets implemented — as a gate it would just
 * teach the author to list every id.
 *
 * Silent when the spec defines no anchors yet (nothing to check against).
 */
export async function planAcWarnings(
  storage: SddStorage,
  task: Task,
  planContent: string,
): Promise<string[]> {
  const spec = (await readArtifactContent(storage, task, 'spec')) ?? ''
  const defined = new Set(extractAnchorIds(spec, 'AC'))
  if (defined.size === 0) return []

  const claimed = new Set<string>()
  for (const row of parsePlanTasks(planContent)) {
    for (const ac of row.claimedAcs) claimed.add(ac.toUpperCase())
  }

  const warnings: string[] = []
  const uncovered = [...defined].filter((ac) => !claimed.has(ac))
  if (uncovered.length > 0) {
    warnings.push(
      `${uncovered.join(', ')} defined in the spec but claimed by no plan row — ` +
        `tag the row that satisfies each one, or drop the scenario from the spec.`,
    )
  }
  const unknown = [...claimed].filter((ac) => !defined.has(ac))
  if (unknown.length > 0) {
    warnings.push(
      `${unknown.join(', ')} claimed by a plan row but not defined in the spec — ` +
        `a typo, or the spec is missing that scenario.`,
    )
  }
  return warnings
}

// ---- Living-spec sediment: apply a change's delta into main's living spec (§13) ----

/** Relative path of a capability's living spec on the default branch (§5.2). */
export function livingSpecRelPath(capability: string): string {
  return path.posix.join('.operon', 'specs', `${capability}.md`)
}

interface DeltaRequirement {
  id: string
  /** Full `### Requirement:` block text (heading + body). */
  text: string
}
export interface ParsedDelta {
  /** Target capability (`.operon/specs/<capability>.md`); null if undeclared. */
  capability: string | null
  added: DeltaRequirement[]
  modified: DeltaRequirement[]
  removed: { id: string; reason?: string }[]
  renamed: { from: string; to: string }[]
}

/**
 * Stable identity of a requirement = its header TEXT (openspec-style header
 * matching, §13 — no numeric `{#REQ-n}` anchors to bookkeep). Strips list
 * markers, the `### Requirement:` prefix, and any legacy `{#...}` anchor, then
 * trims. Compared case-sensitively after this normalization.
 */
function requirementId(raw: string): string {
  return raw
    .replace(/^\s*[-*]\s*/, '')
    .replace(/^#{0,6}\s*Requirement:\s*/i, '')
    .replace(/\{#[^}]*\}/g, '')
    .trim()
}

/** Split spec markdown into preamble + `### Requirement:` blocks keyed by header text. */
function parseRequirementBlocks(spec: string): {
  preamble: string
  blocks: { id: string | null; text: string }[]
} {
  const blocks: { id: string | null; text: string }[] = []
  const preamble: string[] = []
  let cur: string[] | null = null
  let curId: string | null = null
  const flush = () => {
    if (cur) blocks.push({ id: curId, text: cur.join('\n') })
    cur = null
    curId = null
  }
  for (const line of spec.split('\n')) {
    if (/^###\s+Requirement:/i.test(line)) {
      flush()
      cur = [line]
      const name = requirementId(line)
      curId = name || null
    } else if (cur) {
      cur.push(line)
    } else {
      preamble.push(line)
    }
  }
  flush()
  return { preamble: preamble.join('\n'), blocks }
}

/**
 * Parse the `## ADDED/MODIFIED/REMOVED/RENAMED Requirements` sections of one
 * capability's delta body. Requirements are identified by their `### Requirement:
 * <name>` header text (§13 header matching). REMOVED lists requirement names (one
 * per line); RENAMED pairs `- FROM: ### Requirement: <old>` / `- TO: ... <new>`.
 */
function parseDeltaSections(body: string): Omit<ParsedDelta, 'capability'> {
  const added: DeltaRequirement[] = []
  const modified: DeltaRequirement[] = []
  const removed: { id: string; reason?: string }[] = []
  const renamed: { from: string; to: string }[] = []

  const sectionRe = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements/gim
  const marks: { kind: string; start: number; bodyStart: number }[] = []
  let m: RegExpExecArray | null
  while ((m = sectionRe.exec(body)) !== null) {
    marks.push({ kind: m[1].toUpperCase(), start: m.index, bodyStart: sectionRe.lastIndex })
  }
  for (let i = 0; i < marks.length; i++) {
    const seg = body.slice(marks[i].bodyStart, i + 1 < marks.length ? marks[i + 1].start : undefined)
    if (marks[i].kind === 'ADDED' || marks[i].kind === 'MODIFIED') {
      const { blocks } = parseRequirementBlocks(seg)
      for (const b of blocks) {
        if (!b.id) continue
        ;(marks[i].kind === 'ADDED' ? added : modified).push({ id: b.id, text: b.text.replace(/\s+$/, '') })
      }
    } else if (marks[i].kind === 'REMOVED') {
      for (const line of seg.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('-') && !t.startsWith('*') && !/^###\s+Requirement:/i.test(t)) continue
        const cleaned = requirementId(t)
        // A trailing reason may follow an em/en-dash or ' -- '.
        const sepIdx = cleaned.search(/\s[—–]\s|\s--\s/)
        const name = (sepIdx >= 0 ? cleaned.slice(0, sepIdx) : cleaned).trim()
        if (name) removed.push({ id: name, reason: t })
      }
    } else if (marks[i].kind === 'RENAMED') {
      const froms = [...seg.matchAll(/FROM:\s*(.+)/gi)].map((x) => requirementId(x[1]))
      const tos = [...seg.matchAll(/TO:\s*(.+)/gi)].map((x) => requirementId(x[1]))
      for (let j = 0; j < Math.min(froms.length, tos.length); j++) {
        if (froms[j] && tos[j]) renamed.push({ from: froms[j], to: tos[j] })
      }
    }
  }
  return { added, modified, removed, renamed }
}

/**
 * Parse a change delta document into one ParsedDelta per capability. Capabilities
 * are segmented by `## Capability: <name>` headers, so a single delta file can
 * cover multiple capabilities (§13, multi-capability). Content before the first
 * `## Capability:` header is ignored.
 */
export function parseDeltaDoc(delta: string): ParsedDelta[] {
  const capRe = /^##\s+Capability:\s*(.+)$/gim
  const marks = [...delta.matchAll(capRe)]
  const out: ParsedDelta[] = []
  for (let i = 0; i < marks.length; i++) {
    const name = marks[i][1].trim().replace(/\.md$/i, '')
    const start = (marks[i].index ?? 0) + marks[i][0].length
    const end = i + 1 < marks.length ? marks[i + 1].index : undefined
    const chunk = delta.slice(start, end)
    if (name) out.push({ capability: name, ...parseDeltaSections(chunk) })
  }
  return out
}

export interface SedimentConflict {
  kind: string
  id: string
  detail: string
}

/**
 * Apply a parsed delta to a living spec in the fixed order RENAMED → REMOVED →
 * MODIFIED → ADDED, matching by stable id (§13 ⑥). Validates that MODIFIED/REMOVED/
 * RENAMED-from ids exist and ADDED/RENAMED-to ids don't. Any mismatch is a
 * semantic conflict — returns the conflicts and leaves the spec UNCHANGED
 * (serial sediment, conflicts halt for a human; never a partial apply / line merge).
 */
export function applyDelta(
  livingSpec: string,
  delta: ParsedDelta,
): { result: string; conflicts: SedimentConflict[] } {
  const { preamble, blocks } = parseRequirementBlocks(livingSpec)
  const byId = new Map<string, number>()
  blocks.forEach((b, i) => {
    if (b.id) byId.set(b.id, i)
  })
  const conflicts: SedimentConflict[] = []

  for (const r of delta.renamed) {
    const idx = byId.get(r.from)
    if (idx == null) {
      conflicts.push({ kind: 'renamed-missing', id: r.from, detail: `RENAMED from "${r.from}", absent` })
    } else if (byId.has(r.to)) {
      conflicts.push({ kind: 'renamed-target-exists', id: r.to, detail: `RENAMED to "${r.to}", exists` })
    } else {
      // Header text is the identity — rewrite the `### Requirement: <old>` heading to <new>.
      blocks[idx].text = blocks[idx].text.replace(/^(###\s+Requirement:\s*).*$/im, `$1${r.to}`)
      blocks[idx].id = r.to
      byId.delete(r.from)
      byId.set(r.to, idx)
    }
  }
  const removeIdx = new Set<number>()
  for (const rm of delta.removed) {
    const idx = byId.get(rm.id)
    if (idx == null) {
      conflicts.push({ kind: 'removed-missing', id: rm.id, detail: `REMOVED ${rm.id}, absent` })
    } else {
      removeIdx.add(idx)
      byId.delete(rm.id)
    }
  }
  for (const mod of delta.modified) {
    const idx = byId.get(mod.id)
    if (idx == null) {
      conflicts.push({ kind: 'modified-missing', id: mod.id, detail: `MODIFIED ${mod.id}, absent` })
    } else {
      blocks[idx].text = mod.text
    }
  }
  const toAppend: DeltaRequirement[] = []
  for (const add of delta.added) {
    if (byId.has(add.id)) {
      conflicts.push({ kind: 'added-exists', id: add.id, detail: `ADDED ${add.id}, already exists` })
    } else {
      toAppend.push(add)
    }
  }

  if (conflicts.length > 0) return { result: livingSpec, conflicts }

  const kept = blocks.filter((_, i) => !removeIdx.has(i)).map((b) => b.text.replace(/\s+$/, ''))
  const parts: string[] = []
  if (preamble.trim()) parts.push(preamble.replace(/\s+$/, ''))
  parts.push(...kept, ...toAppend.map((a) => a.text))
  return { result: parts.filter(Boolean).join('\n\n') + '\n', conflicts: [] }
}

export interface SedimentResult {
  capability: string
  applied: boolean
  conflicts: SedimentConflict[]
  /** The resulting living-spec content (preview when not applied). */
  preview: string
}

/**
 * Sediment a finished change's delta into the living spec (§13). Reads the
 * CURRENT living spec from the default branch (so a prior change that already
 * sedimented is the base — serial sediment), applies the delta semantically, and
 * on conflict HALTS for a human (no write). When `apply` and conflict-free, the
 * updated living spec is written onto the change branch (it reaches main via the
 * change→main merge / PR, §15.4) and committed. Preview mode (`apply:false`)
 * returns the would-be result and any conflicts without writing.
 */
export async function sedimentChange(
  storage: SddStorage,
  taskId: number,
  actor: ArtifactActor,
  opts: { apply?: boolean } = {},
): Promise<SedimentResult> {
  const parent = storage.taskGet(taskId)
  if (!parent) throw new Error(`Task ${taskId} not found`)
  if (!parent.sddManaged || parent.parentTaskId != null) {
    throw new Error(`Task #${parent.number} is not an SDD parent`)
  }
  if (parent.workspaceId == null) throw new Error(`Task #${parent.number} has no change-branch worktree`)
  const ws = storage.getWorkspace(parent.workspaceId)
  if (!ws) throw new Error(`Workspace ${parent.workspaceId} not found`)
  const project = storage.getProject(parent.projectId)
  if (!project) throw new Error(`Project ${parent.projectId} not found`)

  const deltaContent = await readArtifactContent(storage, parent, 'spec_delta')
  if (deltaContent == null) throw new Error(`Task #${parent.number} has no spec delta to sediment`)
  const deltas = parseDeltaDoc(deltaContent)
  if (deltas.length === 0) {
    throw new Error(
      `Delta for #${parent.number} declares no capability (add a "## Capability: <name>" header)`,
    )
  }
  const base = (await getDefaultBaseBranch(project.rootPath)) ?? 'main'

  // Apply each capability's delta against its OWN living spec (a new capability
  // starts from an empty base → its ADDED requirements bootstrap the file).
  const allConflicts: SedimentConflict[] = []
  const previews: string[] = []
  const writes: { specRel: string; result: string; capability: string }[] = []
  for (const delta of deltas) {
    const cap = delta.capability as string
    const specRel = livingSpecRelPath(cap)
    const living = await gitShow(project.rootPath, base, specRel)
    const { result, conflicts } = applyDelta(living, delta)
    for (const c of conflicts) allConflicts.push({ ...c, detail: `${cap}: ${c.detail}` })
    previews.push(`# ${cap}\n\n${result}`)
    writes.push({ specRel, result, capability: cap })
  }
  const capsLabel = deltas.map((d) => d.capability).join(', ')
  const preview = previews.join('\n\n---\n\n')

  if (allConflicts.length > 0 || !opts.apply) {
    return { capability: capsLabel, applied: false, conflicts: allConflicts, preview }
  }

  for (const w of writes) {
    const absPath = path.join(ws.worktreePath, w.specRel)
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, w.result, 'utf8')
  }
  await commit(ws.worktreePath, `sdd(task #${parent.number}): sediment ${capsLabel} living spec`, {
    includeUnstaged: true,
  })
  storage.taskAppendActivity(parent.id, {
    kind: 'system',
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    body: `Sedimented delta into living spec (${capsLabel})`,
    meta: { capabilities: deltas.map((d) => d.capability), specRefs: writes.map((w) => w.specRel) },
  })
  return { capability: capsLabel, applied: true, conflicts: [], preview }
}

// ---- Gates (§6) ----

export interface GateReason {
  kind: string
  id?: string
  status?: string
  hint: string
}
export interface GateBlock {
  gate: string
  blocked: true
  reasons: GateReason[]
  next: string
}

/** Thrown when an SDD status transition is blocked. `detail` is the structured payload for agents (§6). */
export class GateError extends Error {
  constructor(public readonly detail: GateBlock) {
    super(`SDD gate blocked (${detail.gate}): ${detail.reasons.map((r) => r.hint).join('; ')}`)
    this.name = 'GateError'
  }
}

function requireApproved(
  storage: TaskStorageAdapter,
  taskId: number,
  kind: ArtifactKind,
  reasons: GateReason[],
): void {
  const a = storage.taskArtifactGet(taskId, kind)
  if (!a) {
    reasons.push({ kind, status: 'missing', hint: `write and approve the ${kind} first` })
  } else if (a.status !== 'approved') {
    reasons.push({ kind, status: a.status, hint: `${kind} is ${a.status} — get it (re-)approved` })
  }
}

/** Shared by Gate-2p and Gate-3: no subtask may still be open. */
function requireOpenChildrenFinished(
  storage: TaskStorageAdapter,
  taskId: number,
  reasons: GateReason[],
  action: string,
): void {
  const open = storage
    .taskListChildren(taskId)
    .filter((c) => c.status !== 'done' && c.status !== 'cancelled')
  if (open.length > 0) {
    reasons.push({
      kind: 'subtask',
      status: 'open',
      hint: `finish subtasks before you ${action}: ${open.map((c) => `#${c.number}`).join(', ')}`,
    })
  }
}

/**
 * Enforce SDD status-transition gates (§6). No-op for non-SDD tasks. Gates split
 * by level (§4): a *parent* (change/feature, parentTaskId == null) carries the
 * design/verify/sign-off gates; a *child* (plan item) carries the readiness gate.
 *
 *   Parent  todo → in_progress  Gate-1: spec approved; for a decomposed feature
 *                               also plan approved + ≥1 child. Small-change
 *                               exemption (no plan, no children) → spec only.
 *   Parent  * → in_review       Gate-2p: every child done/cancelled. For a parent,
 *                               in_review means "the change branch is complete,
 *                               awaiting verification + sign-off" — a verifier must
 *                               never be pointed at a half-merged change.
 *   Parent  * → done            Gate-3: spec + acceptance approved + every child
 *                               done/cancelled.
 *   Child   in_progress → in_review  Gate-2: claims ≥1 AC.
 *
 * Throws GateError (structured, agent-readable) when blocked.
 */
export function assertGateOrThrow(storage: TaskStorageAdapter, task: Task, to: TaskStatus): void {
  if (!task.sddManaged) return
  const from = task.status
  if (from === to) return
  const isChild = task.parentTaskId != null
  const reasons: GateReason[] = []
  let gate = ''

  if (!isChild) {
    if (from === 'todo' && to === 'in_progress') {
      gate = 'todo→in_progress (Gate-1)'
      requireApproved(storage, task.id, 'spec', reasons)
      const plan = storage.taskArtifactGet(task.id, 'plan')
      const children = storage.taskListChildren(task.id)
      // Degenerate small-change case (§4): 1 task = 1 spec, no plan/children.
      const smallChange = !plan && children.length === 0
      if (!smallChange) {
        requireApproved(storage, task.id, 'plan', reasons)
        if (children.length === 0) {
          reasons.push({
            kind: 'subtask',
            status: 'missing',
            hint: 'the approved plan has no subtasks yet — Dispatch splits it into at least one',
          })
        }
      }
    } else if (to === 'in_review') {
      gate = `${from}→in_review (Gate-2p)`
      requireOpenChildrenFinished(storage, task.id, reasons, 'verify')
    } else if (to === 'done') {
      gate = `${from}→done (Gate-3)`
      requireApproved(storage, task.id, 'spec', reasons)
      requireApproved(storage, task.id, 'acceptance', reasons)
      requireOpenChildrenFinished(storage, task.id, reasons, 'sign off')
    }
  } else {
    if (from === 'in_progress' && to === 'in_review') {
      gate = 'in_progress→in_review (Gate-2)'
      if (!task.claimedAcs || task.claimedAcs.length === 0) {
        reasons.push({
          kind: 'acceptance',
          status: 'missing',
          hint: 'this subtask claims no AC — record which AC ids it satisfies (claimed_acs)',
        })
      }
      // Deliberately NOT requiring the parent acceptance to exist: acceptance is
      // now the verifier's report, written at parent review time, so at Gate-2 it
      // legitimately does not exist yet.
    }
  }

  if (reasons.length === 0) return
  throw new GateError({
    gate,
    blocked: true,
    reasons,
    next: `resolve then retry: ${reasons.map((r) => r.hint).join('; ')}`,
  })
}
