/**
 * OperonSpec lifecycle: start, answer, approve, request changes, resume, stop, read.
 *
 * The design work itself is `design-run.ts`; this module owns the transitions
 * between stages and the two gates' preconditions. Every entry point that
 * starts work goes through `launch`, which refuses a second concurrent run.
 */

import type { ProjectStorageAdapter, TaskStorageAdapter } from '../../storage/interface.js'
import type { Task, TaskActor } from '../../types/task.js'
import {
  ACTIVE_SPEC_STAGES,
  type SpecAgentRun,
  type SpecRun,
  type SpecSeat,
  type SpecStage,
  type SpecTicket,
  type SpecView,
} from '../../types/spec.js'
import { provisionWorkspace } from '../workspace-provision.js'
import { broadcastTask } from '../task-events.js'
import { changeBranchName } from '../sdd/sdd-service.js'
import { defaultSpecConfig, specPool, withBuildDefaults } from './config.js'
import {
  SPEC_FILES,
  blobSha,
  candidateFile,
  listCandidateKeys,
  readSpecFile,
  readSpecJson,
  specDir,
  writeSpecFiles,
  type SpecLocation,
} from './files.js'
import {
  BUILDER_FILE,
  isDesignRunActive,
  roundMarker,
  startDesignRun,
  stopDesignRun,
  topologicalOrder,
  type PendingQuestions,
} from './design-run.js'
import { ticketDescription } from './prompts.js'
import { readRunView } from '../workflow/store.js'
import { advance, isBuildActive, resumeBuild, settleSpecNotice, startBuild, stopBuild, type BuildStorage } from './build-run.js'
import { isReviewActive, requestSignoffChanges, reviewSummary } from './review-run.js'
import { completeTaskAfterHumanReview } from '../channel/agent-orchestrator.js'

export type SpecStorage = TaskStorageAdapter & Pick<ProjectStorageAdapter, 'getProject' | 'getWorkspace' | 'createWorkspace'>

/** Stages in which a spec is still being designed — a second start in the same chat reuses it. */
const OPEN_STAGES: readonly SpecStage[] = ['grounding', 'designing', 'awaiting_answers', 'awaiting_design', 'stopped', 'failed']

export class SpecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpecError'
  }
}

function requireSpec(storage: SpecStorage, taskId: number): { task: Task; run: SpecRun } {
  const task = storage.taskGet(taskId)
  if (!task) throw new SpecError(`Task ${taskId} not found`)
  const run = storage.specRunGet(taskId)
  if (!run) throw new SpecError(`Task #${task.number} is not an OperonSpec`)
  return { task, run }
}

function locationOf(storage: SpecStorage, task: Task): SpecLocation {
  const workspace = task.workspaceId != null ? storage.getWorkspace(task.workspaceId) : null
  if (!workspace) throw new SpecError(`Spec #${task.number} has lost its change worktree`)
  return { taskId: task.id, taskNumber: task.number, worktreePath: workspace.worktreePath }
}

function launch(storage: SpecStorage, task: Task): string {
  const run = storage.specRunGet(task.id)
  if (!run) throw new SpecError(`Task #${task.number} is not an OperonSpec`)
  if (isDesignRunActive(task.id)) throw new SpecError(`Spec #${task.number} is already running`)
  return startDesignRun({ storage, task, run, loc: locationOf(storage, task), chatId: task.sourceChatId })
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export interface StartSpecInput {
  projectId: number
  /** The chat the alignment happened in; results are delivered back there. */
  chatId: number
  actor: TaskActor
  title: string
  brief: string
  /** The chat's own provider and model — the lead runs there. */
  lead: SpecSeat
  /** Providers usable here. */
  available: readonly string[]
  /** Candidate providers the user asked for, if any. */
  candidates?: readonly string[]
}

export interface StartSpecResult {
  task: Task
  runId: string | null
  /** True when this chat already had an open spec and it was returned instead. */
  reused: boolean
}

export async function startSpec(storage: SpecStorage, input: StartSpecInput): Promise<StartSpecResult> {
  const project = storage.getProject(input.projectId)
  if (!project) throw new SpecError(`Project ${input.projectId} not found`)
  const brief = input.brief.trim()
  if (!brief) throw new SpecError('The brief is empty — write it from the alignment conversation first')

  // One open spec per chat: a second call is almost always a retry or a
  // duplicate, and two specs racing on one conversation would confuse both.
  const existing = storage
    .taskList({ projectId: input.projectId })
    .find((t) => t.sourceChatId === input.chatId && t.specStage != null && OPEN_STAGES.includes(t.specStage))
  if (existing) return { task: existing, runId: storage.specRunGet(existing.id)?.workflowRunId ?? null, reused: true }

  // Pick seats before creating anything: too few agents is a reason not to start.
  const config = defaultSpecConfig({ available: input.available, lead: input.lead, candidates: input.candidates })

  const task = storage.taskCreate({
    projectId: input.projectId,
    title: input.title.trim() || 'Untitled spec',
    description: '',
    sourceChatId: input.chatId,
    createdBy: input.actor.type === 'human' ? 'human' : 'agent',
    actorId: input.actor.id,
    actorName: input.actor.name,
  })
  const branchName = changeBranchName(task.number)
  const workspace = await provisionWorkspace(storage, {
    projectId: input.projectId,
    name: `Spec · task #${task.number}`,
    branch: branchName,
    dir: `task-${task.number}`,
  })
  storage.taskUpdate(task.id, { branchName, workspaceId: workspace.id }, input.actor)
  storage.specRunCreate({ taskId: task.id, stage: 'grounding', config })
  storage.taskAppendActivity(task.id, {
    kind: 'branch',
    actorType: input.actor.type,
    actorId: input.actor.id,
    actorName: input.actor.name,
    body: `Started an OperonSpec on \`${branchName}\` — candidates: ${config.candidates.map((c) => c.providerId).join(', ')}; judge: ${config.judge.providerId}`,
    meta: { branch: branchName },
  })

  const fresh = storage.taskGet(task.id) as Task
  await writeSpecFiles(locationOf(storage, fresh), { [SPEC_FILES.brief]: brief }, 'brief')
  const runId = launch(storage, fresh)
  broadcastTask(storage, task.id)
  return { task: storage.taskGet(task.id) as Task, runId, reused: false }
}

// ---------------------------------------------------------------------------
// Answer the user's questions
// ---------------------------------------------------------------------------

export async function answerSpecQuestions(storage: SpecStorage, taskId: number, answers: string): Promise<string> {
  const { task, run } = requireSpec(storage, taskId)
  if (run.stage !== 'awaiting_answers') {
    throw new SpecError(`Spec #${task.number} is not waiting for answers (it is ${run.stage})`)
  }
  const text = answers.trim()
  if (!text) throw new SpecError('The answers are empty')
  const loc = locationOf(storage, task)
  const pending = await readSpecJson<PendingQuestions>(loc, SPEC_FILES.questions)
  if (!pending) throw new SpecError(`Spec #${task.number} has no open questions`)

  const previous = (await readSpecFile(loc, SPEC_FILES.answers)) ?? ''
  const block = [
    roundMarker(pending),
    `## ${pending.kind === 'diverged' ? 'Direction' : 'Builder questions'} — ${new Date().toISOString().slice(0, 10)}`,
    ...pending.questions.map((q, i) => `${i + 1}. ${q.question}`),
    '',
    '### Answers',
    text,
  ].join('\n')
  await writeSpecFiles(loc, { [SPEC_FILES.answers]: previous ? `${previous.trimEnd()}\n\n${block}\n` : `${block}\n` }, 'answers')
  storage.specRunUpdate(task.id, { stage: 'designing' })
  return launch(storage, task)
}

// ---------------------------------------------------------------------------
// Gate 1: approve the design
// ---------------------------------------------------------------------------

export interface ApproveSpecInput {
  /** Provider to build each ticket, by ticket key; the rest get the spec's implementer seat. */
  implementers?: Record<string, string>
  /** How many tickets may be built at once (1–5); the spec's current setting when absent. */
  concurrency?: number
}

/** Bounds of the build's concurrency a person can pick at gate 1. */
export const MAX_CONCURRENCY = 5

export async function approveSpecDesign(
  storage: BuildStorage,
  taskId: number,
  actor: TaskActor,
  input: ApproveSpecInput = {},
): Promise<Task[]> {
  const { task, run } = requireSpec(storage, taskId)
  if (run.stage !== 'awaiting_design') {
    throw new SpecError(`Spec #${task.number} has no design waiting for approval (it is ${run.stage})`)
  }
  const loc = locationOf(storage, task)
  const design = await readSpecFile(loc, SPEC_FILES.design)
  const tickets = await readSpecJson<SpecTicket[]>(loc, SPEC_FILES.tickets)
  if (!design || !tickets || tickets.length === 0) {
    throw new SpecError(`Spec #${task.number} is missing its design or tickets — resume the design run`)
  }
  const ordered = topologicalOrder(tickets)
  if (!ordered) throw new SpecError(`Spec #${task.number}'s tickets depend on each other in a cycle`)

  // Blockers come first in topological order, so every blockedBy key already
  // has a task id by the time the ticket that names it is created.
  const idByKey = new Map<string, number>()
  const designPath = `${specDir(task.number)}/${SPEC_FILES.design}`
  const children: Task[] = []
  for (const ticket of ordered) {
    const child = storage.taskCreate({
      projectId: task.projectId,
      title: ticket.title,
      description: ticketDescription(ticket, task.number, designPath),
      parentTaskId: task.id,
      blockedBy: ticket.blockedBy.map((key) => idByKey.get(key)).filter((id): id is number => id != null),
      createdBy: actor.type === 'human' ? 'human' : 'agent',
      actorId: actor.id,
      actorName: actor.name,
    })
    idByKey.set(ticket.key, child.id)
    children.push(child)
  }

  const concurrency = input.concurrency
  const config =
    concurrency != null && Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= MAX_CONCURRENCY
      ? { ...run.config, concurrency }
      : run.config
  storage.specRunUpdate(task.id, { stage: 'building', designSha: blobSha(design), config })
  storage.taskAppendActivity(task.id, {
    kind: 'system',
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    body: `Approved the design — ${children.length} ticket(s): ${children.map((c) => `#${c.number}`).join(', ')}`,
  })
  await startBuild(
    storage,
    task,
    ordered.map((ticket, i) => ({ key: ticket.key, taskId: children[i].id, implementer: input.implementers?.[ticket.key] })),
  )
  broadcastTask(storage, task.id)
  for (const child of children) broadcastTask(storage, child.id)
  return children
}

// ---------------------------------------------------------------------------
// Gate 2: sign off the change
// ---------------------------------------------------------------------------

/** Merge the built and reviewed change into the default branch. */
export async function signOffSpec(storage: BuildStorage, taskId: number, actor: TaskActor): Promise<void> {
  const { task, run } = requireSpec(storage, taskId)
  if (run.stage !== 'awaiting_signoff') {
    throw new SpecError(`Spec #${task.number} is not waiting for sign-off (it is ${run.stage})`)
  }
  const done = await completeTaskAfterHumanReview(task.id, {
    type: actor.type === 'agent' ? 'agent' : 'human',
    id: actor.id ?? null,
    name: actor.name,
  })
  if (!done.ok) throw new SpecError(done.reason)
  settleSpecNotice(storage, task.id, 'spec_gate')
}

// ---------------------------------------------------------------------------
// Request changes / resume / stop
// ---------------------------------------------------------------------------

export interface RequestChangesInput {
  comment: string
  /** Throw the candidates away and design again from scratch (default: re-synthesize only). */
  redesign?: boolean
}

export async function requestSpecChanges(
  storage: BuildStorage,
  taskId: number,
  input: RequestChangesInput,
  actor: TaskActor,
): Promise<string> {
  const { task, run } = requireSpec(storage, taskId)
  // Gate 2: the change is built; what the user asks for becomes a ticket.
  if (run.stage === 'awaiting_signoff') {
    const comment = input.comment.trim()
    if (!comment) throw new SpecError('Say what should change')
    const child = await requestSignoffChanges(storage, task, comment)
    settleSpecNotice(storage, task.id, 'spec_gate')
    storage.taskAppendActivity(task.id, {
      kind: 'comment',
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      body: `Requested changes before sign-off (ticket #${child.number}): ${comment}`,
    })
    broadcastTask(storage, task.id)
    return run.workflowRunId ?? ''
  }
  if (run.designSha != null) throw new SpecError(`Spec #${task.number}'s design is signed; it cannot take design changes now`)
  if (!['awaiting_design', 'awaiting_answers', 'stopped', 'failed'].includes(run.stage)) {
    throw new SpecError(`Spec #${task.number} cannot take changes while it is ${run.stage}`)
  }
  const comment = input.comment.trim()
  if (!comment) throw new SpecError('Say what should change')
  const loc = locationOf(storage, task)

  const previous = (await readSpecFile(loc, SPEC_FILES.feedback)) ?? ''
  const entry = `## ${actor.name} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n${comment}`
  const files: Record<string, string | null> = {
    [SPEC_FILES.feedback]: previous ? `${previous.trimEnd()}\n\n${entry}\n` : `${entry}\n`,
    [SPEC_FILES.design]: null,
    [SPEC_FILES.synthesis]: null,
    [SPEC_FILES.questions]: null,
    [SPEC_FILES.tickets]: null,
    [BUILDER_FILE]: null,
  }
  if (input.redesign) {
    for (const key of await listCandidateKeys(loc)) files[candidateFile(key)] = null
    files[SPEC_FILES.judge] = null
  }
  await writeSpecFiles(loc, files, input.redesign ? 'changes requested — redesign' : 'changes requested')
  storage.taskAppendActivity(task.id, {
    kind: 'comment',
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    body: `${input.redesign ? 'Requested a fresh design' : 'Requested changes'}: ${comment}`,
  })
  storage.specRunUpdate(task.id, { stage: 'designing' })
  return launch(storage, task)
}

export async function resumeSpec(storage: BuildStorage, taskId: number): Promise<string | null> {
  const { task, run } = requireSpec(storage, taskId)
  if (run.stage !== 'stopped' && run.stage !== 'failed') {
    throw new SpecError(`Spec #${task.number} is ${run.stage}; only a stopped or failed spec can resume`)
  }
  // Signed at gate 1: what stopped was the build, not the design.
  if (run.designSha != null) {
    await resumeBuild(storage, task.id)
    return run.workflowRunId
  }
  return launch(storage, task)
}

export function stopSpec(storage: SpecStorage, taskId: number): boolean {
  requireSpec(storage, taskId)
  return stopDesignRun(taskId) || stopBuild(taskId)
}

/**
 * A run whose stage says it is executing but which no longer has a process
 * behind it — the app quit mid-run. Mark it stopped so the UI offers Resume
 * instead of a spinner that never ends. Called once at startup.
 */
export function sweepInterruptedSpecRuns(storage: SpecStorage): number {
  let swept = 0
  for (const run of storage.specRunList(ACTIVE_SPEC_STAGES)) {
    if (isDesignRunActive(run.taskId)) continue
    storage.specRunUpdate(run.taskId, { stage: 'stopped', error: 'The app quit while the design was running.' })
    swept++
  }
  return swept
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getSpecView(storage: SpecStorage, taskId: number): Promise<SpecView> {
  const { task, run } = requireSpec(storage, taskId)
  const workspace = task.workspaceId != null ? storage.getWorkspace(task.workspaceId) : null
  const config = withBuildDefaults(run.config)
  const base = {
    taskId: task.id,
    taskNumber: task.number,
    title: task.title,
    // The build seats as they will be used, also before gate 1 fills them in.
    run: { ...run, config },
    providers: specPool(config),
    worktreePath: workspace?.worktreePath ?? null,
    specDir: specDir(task.number),
    running: isDesignRunActive(task.id) || isBuildActive(task.id) || isReviewActive(task.id),
    ...specAgents(run),
  }
  if (!workspace) {
    return {
      ...base,
      brief: null,
      grounding: null,
      candidates: [],
      judge: null,
      design: null,
      synthesis: null,
      tickets: null,
      questions: null,
      feedback: null,
      review: null,
      reviewSummary: null,
      designChanged: false,
      ticketTasks: {},
    }
  }
  const loc: SpecLocation = { taskId: task.id, taskNumber: task.number, worktreePath: workspace.worktreePath }
  const keys = await listCandidateKeys(loc)
  const [brief, grounding, judge, design, synthesis, tickets, pending, feedback, review, summary, candidates] = await Promise.all([
    readSpecFile(loc, SPEC_FILES.brief),
    readSpecFile(loc, SPEC_FILES.grounding),
    readSpecFile(loc, SPEC_FILES.judge),
    readSpecFile(loc, SPEC_FILES.design),
    readSpecFile(loc, SPEC_FILES.synthesis),
    readSpecJson<SpecTicket[]>(loc, SPEC_FILES.tickets),
    readSpecJson<PendingQuestions>(loc, SPEC_FILES.questions),
    readSpecFile(loc, SPEC_FILES.feedback),
    readSpecFile(loc, SPEC_FILES.review),
    reviewSummary(loc),
    Promise.all(
      keys.map(async (key) => ({
        key,
        providerId: run.config.candidates[key.charCodeAt(0) - 65]?.providerId ?? '?',
        content: (await readSpecFile(loc, candidateFile(key))) ?? '',
      })),
    ),
  ])
  return {
    ...base,
    brief,
    grounding,
    candidates,
    judge,
    design,
    synthesis,
    tickets,
    questions: run.stage === 'awaiting_answers' ? (pending?.questions ?? null) : null,
    feedback,
    review,
    reviewSummary: review ? summary : null,
    designChanged: run.designSha != null && design != null && blobSha(design) !== run.designSha,
    ticketTasks: ticketTasksOf(storage, task.id, run, tickets),
  }
}

/** Every agent call across the spec's runs, and the wall-clock time those runs took. */
function specAgents(run: SpecRun): { agents: SpecAgentRun[]; elapsedMs: number } {
  const agents: SpecAgentRun[] = []
  // Older rows predate run history; their latest run is all there is.
  const runIds = run.runIds.length > 0 ? run.runIds : run.workflowRunId ? [run.workflowRunId] : []
  for (const runId of runIds) {
    const view = readRunView(runId)
    // Pruned from the workflow store: its agents are gone, its files are not.
    if (!view) continue
    for (const a of view.agents) {
      agents.push({
        runId,
        index: a.index,
        label: a.label,
        phase: a.phase,
        agentType: a.agentType,
        modelId: a.modelId,
        state: a.state,
        resultPreview: a.resultPreview,
        error: a.error,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
      })
    }
  }
  return { agents, elapsedMs: workingTime(agents) }
}

/**
 * How long agents were at work: the union of their intervals, so parallel
 * candidates count once and the waits between runs (for an approval, for
 * answers) not at all.
 */
function workingTime(agents: readonly SpecAgentRun[]): number {
  const now = Date.now()
  const spans = agents
    .filter((a) => a.startedAt != null)
    .map((a) => [a.startedAt as number, a.endedAt ?? (a.state === 'running' ? now : (a.startedAt as number))] as const)
    .sort((x, y) => x[0] - y[0])
  let total = 0
  let end = -Infinity
  for (const [from, to] of spans) {
    if (to <= end) continue
    total += to - Math.max(from, end)
    end = to
  }
  return total
}

/**
 * Which subtask each ticket became. The build record names it; specs approved
 * before the build stage have none, and there the title is the link.
 */
function ticketTasksOf(storage: SpecStorage, taskId: number, run: SpecRun, tickets: SpecTicket[] | null): SpecView['ticketTasks'] {
  if (!tickets) return {}
  const children = storage.taskListChildren(taskId)
  const out: SpecView['ticketTasks'] = {}
  for (const ticket of tickets) {
    const id = run.build.find((b) => b.key === ticket.key)?.taskId
    const child = id != null ? children.find((c) => c.id === id) : children.find((c) => c.title === ticket.title)
    if (child) out[ticket.key] = { id: child.id, number: child.number, status: child.status, workspaceId: child.workspaceId ?? null }
  }
  return out
}

/**
 * Whether an approved spec's design.md has changed since it was signed (a ticket
 * merged an edit to it, or someone edited it by hand). New tickets wait until
 * the user signs the new text.
 */
export async function specDesignChanged(storage: SpecStorage, taskId: number): Promise<boolean> {
  const task = storage.taskGet(taskId)
  const run = task ? storage.specRunGet(taskId) : null
  if (!task || !run || run.designSha == null || task.workspaceId == null) return false
  const workspace = storage.getWorkspace(task.workspaceId)
  if (!workspace) return false
  const design = await readSpecFile(
    { taskId: task.id, taskNumber: task.number, worktreePath: workspace.worktreePath },
    SPEC_FILES.design,
  )
  return design != null && blobSha(design) !== run.designSha
}

/** Sign the changed design.md as it now stands; the tickets already created stay as they are. */
export async function reapproveSpecDesign(storage: BuildStorage, taskId: number, actor: TaskActor): Promise<void> {
  const { task, run } = requireSpec(storage, taskId)
  if (run.designSha == null) throw new SpecError(`Spec #${task.number} has not been approved yet (it is ${run.stage})`)
  const design = await readSpecFile(locationOf(storage, task), SPEC_FILES.design)
  if (!design) throw new SpecError(`Spec #${task.number} has no design to approve`)
  storage.specRunUpdate(task.id, { designSha: blobSha(design) })
  storage.taskAppendActivity(task.id, {
    kind: 'system',
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    body: 'Re-approved the changed design',
  })
  broadcastTask(storage, task.id)
  // Tickets held back by the change can start now.
  await advance(storage, task.id)
}
