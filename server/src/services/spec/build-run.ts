/**
 * The build stage of a spec: ⑤ Build, after gate 1.
 *
 * Not a long-running loop. A build spans hours, people step in, the app
 * restarts — so every ticket's state lives on the spec row (`spec_runs.build`)
 * and the stage advances one step at each event:
 *
 *   gate 1 approved       → dispatch the frontier
 *   ticket → in_review    → a reviewer from another family reads its diff
 *   review passed         → merge into the change branch → dispatch the frontier
 *   review asked changes  → back to the same implementer session (3 rounds, then blocked)
 *   every ticket merged   → the parent goes to review
 *   app start             → reviews a restart cut short run again
 *
 * The frontier is every waiting ticket whose blockers are done, up to the
 * spec's concurrency. All state changes are synchronous read-modify-writes of
 * the spec row (SQLite calls are synchronous), so two events finishing at once
 * cannot lose each other's update; the only awaits are git and agents.
 *
 * Reviews are recorded in the spec's own workflow run, after its design agents,
 * so the progress card and the Workflow tab show the whole spec in one place.
 */

import type { AgentBindingStorageAdapter, ChannelStorageAdapter, NotificationStorageAdapter } from '../../storage/interface.js'
import type { Task } from '../../types/task.js'
import type { SpecRun, SpecRuling, SpecTicket, SpecTicketBuild } from '../../types/spec.js'
import { appendEvent, markExecuting, readRunView, unmarkExecuting } from '../workflow/store.js'
import { registerWorkflowAbort, unregisterWorkflowAbort } from '../workflow/registry.js'
import { RunEventWriter } from '../workflow/writer.js'
import { deliverWorkflowResult } from '../workflow/completion.js'
import { broadcastTask } from '../task-events.js'
import { emitCounts, notify } from '../notification-service.js'
import { emitInboxEvent } from '../channel-bus.js'
import { commit, getDiffStatText, getFileDiffRange, getHeadSha, getMergeBase } from '../git.js'
import { dispatchProjectTask, landSpecTicket, wakeTaskBinding } from '../channel/agent-orchestrator.js'
import { SpecAgents } from './agents.js'
import { familyOf, reviewerFor, seatFor, withBuildDefaults } from './config.js'
import { getOrCreateSpecBuilder, type BuilderStorage } from './builders.js'
import { SPEC_FILES, readSpecFile, readSpecJson, specDir, writeSpecFiles, type SpecLocation } from './files.js'
import {
  MAX_COORDINATOR_RETRIES,
  TICKET_REVIEW_SCHEMA,
  blockedTicketMessage,
  reworkMessage,
  ticketDescription,
  ticketReviewPrompt,
  type TicketReviewIssue,
  type TicketReviewResult,
} from './prompts.js'
import { specDesignChanged, type SpecStorage } from './spec-service.js'
import { onAllTicketsMerged } from './review-run.js'
import { ensureCoordinator, onCoordinatorTurnEnded, wakeCoordinator } from './coordinator.js'

export type BuildStorage = SpecStorage &
  BuilderStorage &
  NotificationStorageAdapter &
  Pick<AgentBindingStorageAdapter, 'getBinding'> &
  Pick<ChannelStorageAdapter, 'getAgent'>

/** Review rounds that may ask for changes before a ticket is handed to a person. */
export const MAX_REVIEW_ROUNDS = 3

const REVIEWER_ACTOR = { type: 'agent' as const, id: null, name: 'OperonSpec reviewer' }

// ---------------------------------------------------------------------------
// The spec row's build state
// ---------------------------------------------------------------------------

export function patchTicket(storage: BuildStorage, specId: number, taskId: number, patch: Partial<SpecTicketBuild>): SpecTicketBuild | null {
  const run = storage.specRunGet(specId)
  if (!run) return null
  const build = run.build.map((b) => (b.taskId === taskId ? { ...b, ...patch } : b))
  storage.specRunUpdate(specId, { build })
  return build.find((b) => b.taskId === taskId) ?? null
}

export function addRulings(storage: BuildStorage, specId: number, ticketKey: string, rulings: readonly string[]): void {
  const run = storage.specRunGet(specId)
  if (!run || rulings.length === 0) return
  const known = new Set(run.rulings.map((r) => `${r.ticketKey}\n${r.ruling}`))
  const added: SpecRuling[] = rulings
    .map((r) => r.trim())
    .filter((r) => r && !known.has(`${ticketKey}\n${r}`))
    .map((ruling) => ({ ticketKey, ruling }))
  if (added.length > 0) storage.specRunUpdate(specId, { rulings: [...run.rulings, ...added] })
}

/**
 * The tickets to start now: waiting, every blocker done, and no more than the
 * free slots allow. Building and reviewing tickets hold a slot; a blocked one
 * does not (it waits on a person, not on compute). Pure, for tests.
 */
export function frontier(
  build: readonly SpecTicketBuild[],
  tasks: ReadonlyMap<number, Pick<Task, 'status' | 'blockedBy'>>,
  concurrency: number,
): SpecTicketBuild[] {
  const busy = build.filter((b) => b.state === 'building' || b.state === 'reviewing').length
  const slots = Math.max(0, concurrency - busy)
  if (slots === 0) return []
  const finished = (id: number) => {
    const status = tasks.get(id)?.status
    // A blocker that is not in this spec (deleted, moved) cannot hold it back.
    return status == null || status === 'done' || status === 'cancelled'
  }
  return build
    .filter((b) => b.state === 'waiting' && tasks.get(b.taskId)?.status === 'todo')
    .filter((b) => (tasks.get(b.taskId)?.blockedBy ?? []).every(finished))
    .slice(0, slots)
}

// ---------------------------------------------------------------------------
// Gate 1 → the first tickets
// ---------------------------------------------------------------------------

export interface TicketAssignment {
  key: string
  taskId: number
  /** Provider to build it; the spec's implementer seat when absent. */
  implementer?: string
}

/**
 * Called once gate 1 created the ticket subtasks: give every ticket its builder
 * and reviewer, then start the ones that can start.
 */
export async function startBuild(storage: BuildStorage, spec: Task, tickets: readonly TicketAssignment[]): Promise<void> {
  const run = storage.specRunGet(spec.id)
  if (!run) return
  const config = withBuildDefaults(run.config)
  const build: SpecTicketBuild[] = tickets.map((t) => {
    const implementer = t.implementer ?? config.implementer.providerId
    const agent = getOrCreateSpecBuilder(storage, t.implementer ? seatFor(config, t.implementer) : config.implementer)
    storage.taskUpdate(t.taskId, { assignedAgentId: agent.id }, { type: 'system', name: 'OperonSpec' })
    return { key: t.key, taskId: t.taskId, implementer, reviewer: reviewerFor(config, implementer), rounds: 0, state: 'waiting' }
  })
  storage.specRunUpdate(spec.id, { config, build })
  // Its session starts with the first thing it is asked; the binding makes it reachable from now on.
  await ensureCoordinator(storage, spec)
  await advance(storage, spec.id)
}

/**
 * Add a ticket to a build already under way — the fixes the whole-change review
 * asked for, or changes the user requested at gate 2. It goes on the spec's
 * ticket list (so the Tickets tab shows it), becomes a subtask, and is built and
 * reviewed like any other.
 */
export async function addTicket(storage: BuildStorage, spec: Task, ticket: SpecTicket): Promise<Task> {
  const run = storage.specRunGet(spec.id)
  const specWs = spec.workspaceId != null ? storage.getWorkspace(spec.workspaceId) : null
  if (!run || !specWs) throw new Error(`spec #${spec.number} has no build to add a ticket to`)
  const loc: SpecLocation = { taskId: spec.id, taskNumber: spec.number, worktreePath: specWs.worktreePath }
  const tickets = (await readSpecJson<SpecTicket[]>(loc, SPEC_FILES.tickets)) ?? []
  await writeSpecFiles(loc, { [SPEC_FILES.tickets]: JSON.stringify([...tickets, ticket], null, 2) }, `ticket ${ticket.key}`)
  const config = withBuildDefaults(run.config)
  const implementer = config.implementer.providerId
  const agent = getOrCreateSpecBuilder(storage, config.implementer)
  const blockedBy = ticket.blockedBy
    .map((key) => run.build.find((b) => b.key === key)?.taskId)
    .filter((id): id is number => id != null)
  const child = storage.taskCreate({
    projectId: spec.projectId,
    title: ticket.title,
    description: ticketDescription(ticket, spec.number, `${specDir(spec.number)}/${SPEC_FILES.design}`),
    parentTaskId: spec.id,
    assignedAgentId: agent.id,
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
    createdBy: 'agent',
    actorName: 'OperonSpec',
  })
  const entry: SpecTicketBuild = {
    key: ticket.key,
    taskId: child.id,
    implementer,
    reviewer: reviewerFor(config, implementer),
    rounds: 0,
    state: 'waiting',
  }
  storage.specRunUpdate(spec.id, { build: [...(storage.specRunGet(spec.id)?.build ?? []), entry] })
  broadcastTask(storage, child.id)
  return child
}

/**
 * Start every ticket the frontier allows. Paused while the spec is not building
 * (stopped, failed, a design that broke) or its design changed since it was
 * signed — `dispatchProjectTask` would refuse those anyway; checking first keeps
 * a refusal from reading as a failure.
 */
export async function advance(storage: BuildStorage, specId: number): Promise<void> {
  const run = storage.specRunGet(specId)
  if (!run || run.stage !== 'building' || run.build.length === 0) return
  if (await specDesignChanged(storage, specId)) return
  const tasks = new Map(run.build.map((b) => [b.taskId, storage.taskGet(b.taskId)] as const).filter((e): e is [number, Task] => e[1] != null))
  const ready = frontier(run.build, tasks, withBuildDefaults(run.config).concurrency)
  // Claimed before any await, so an event landing meanwhile sees them taken.
  for (const ticket of ready) patchTicket(storage, specId, ticket.taskId, { state: 'building' })
  for (const ticket of ready) {
    const task = tasks.get(ticket.taskId)
    try {
      if (task?.assignedAgentId == null) throw new Error('no builder assigned')
      await dispatchProjectTask(ticket.taskId, task.assignedAgentId)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[Spec] could not start ticket ${ticket.key}:`, err)
      const spec = storage.taskGet(specId)
      if (spec) await blockTicket(storage, spec, ticket.taskId, `Could not start: ${reason}`, `Ticket ${ticket.key} could not start: ${reason}`)
    }
  }
  if (ready.length > 0) broadcastTask(storage, specId)
}

// ---------------------------------------------------------------------------
// A ticket is ready for review
// ---------------------------------------------------------------------------

/** The spec a ticket belongs to, with its build entry — null for any other task. */
function ticketOf(storage: BuildStorage, taskId: number): { ticket: Task; spec: Task; run: SpecRun; entry: SpecTicketBuild } | null {
  const ticket = storage.taskGet(taskId)
  if (!ticket || ticket.parentTaskId == null) return null
  const spec = storage.taskGet(ticket.parentTaskId)
  const run = spec ? storage.specRunGet(spec.id) : null
  const entry = run?.build.find((b) => b.taskId === taskId)
  return spec && run && entry ? { ticket, spec, run, entry } : null
}

/** A ticket's implementer started a chat: remember it, so it can be opened after the ticket's workspace is gone. */
export function recordTicketChat(storage: BuildStorage, taskId: number, chatId: number): void {
  const found = ticketOf(storage, taskId)
  if (!found || found.entry.chatIds?.includes(chatId)) return
  patchTicket(storage, found.spec.id, taskId, { chatIds: [...(found.entry.chatIds ?? []), chatId] })
  broadcastTask(storage, found.spec.id)
}

/** Whether a task is a ticket the build stage reviews (so nobody else needs to be told it is in review). */
export function isReviewedTicket(storage: BuildStorage, taskId: number): boolean {
  return ticketOf(storage, taskId) != null
}

/**
 * A ticket's implementer moved it to in_review: review it. While the spec is
 * paused the ticket waits in review, and Resume picks it up.
 */
export function onTicketInReview(storage: BuildStorage, taskId: number): void {
  const found = ticketOf(storage, taskId)
  if (!found || found.run.stage !== 'building') return
  if (found.entry.state === 'merged' || reviewing.has(taskId)) return
  // A blocked ticket coming back means a person got it moving again: its rounds start over.
  const fresh = found.entry.state === 'blocked' ? { rounds: 0, blockedReason: undefined, coordinator: undefined } : {}
  if (found.entry.state === 'blocked') settleSpecNotice(storage, found.spec.id, 'spec_blocked')
  patchTicket(storage, found.spec.id, taskId, { ...fresh, state: 'reviewing', nudged: undefined })
  broadcastTask(storage, found.spec.id)
  void reviewTicket(storage, taskId)
}

/** Tickets whose review is executing in this process. */
const reviewing = new Set<number>()

async function reviewTicket(storage: BuildStorage, taskId: number): Promise<void> {
  const found = ticketOf(storage, taskId)
  if (!found || reviewing.has(taskId)) return
  const { ticket, spec, entry } = found
  reviewing.add(taskId)
  const session = sessionFor(storage, spec)
  try {
    const result = await session.run((agents) => runReview(storage, agents, spec, ticket, entry))
    if (result) await settleReview(storage, spec, ticket, entry, result)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const stopped = session.stopped
    // Paused: the ticket stays "reviewing" with no review running; Resume runs it again.
    storage.specRunUpdate(spec.id, stopped ? { stage: 'stopped' } : { stage: 'failed', error: `Reviewing ${entry.key} failed: ${reason}` })
    if (!stopped) {
      storage.taskAppendActivity(spec.id, {
        kind: 'system',
        actorType: 'system',
        actorName: 'OperonSpec',
        body: `Reviewing ticket #${ticket.number} failed: ${reason}`,
      })
    }
    broadcastTask(storage, spec.id)
  } finally {
    reviewing.delete(taskId)
  }
}

async function runReview(
  storage: BuildStorage,
  agents: SpecAgents,
  spec: Task,
  ticket: Task,
  entry: SpecTicketBuild,
): Promise<TicketReviewResult | null> {
  const ticketWs = ticket.workspaceId != null ? storage.getWorkspace(ticket.workspaceId) : null
  const specWs = spec.workspaceId != null ? storage.getWorkspace(spec.workspaceId) : null
  if (!ticketWs || !specWs || !spec.branchName) throw new Error(`ticket #${ticket.number} has no worktree to review`)
  const loc: SpecLocation = { taskId: spec.id, taskNumber: spec.number, worktreePath: specWs.worktreePath }

  // What is reviewed must be what gets merged: commit whatever the implementer left uncommitted.
  await commit(ticketWs.worktreePath, `spec(task #${ticket.number}): ready for review`, { includeUnstaged: true }).catch(() => undefined)
  const head = await getHeadSha(ticketWs.worktreePath)
  if (!head) throw new Error(`ticket #${ticket.number}'s branch has no commits`)

  const rereview = entry.reviewedSha != null && (entry.openIssues?.length ?? 0) > 0
  const base = rereview ? (entry.reviewedSha as string) : await getMergeBase(ticketWs.worktreePath, spec.branchName)
  if (!base) throw new Error(`ticket #${ticket.number} shares no history with ${spec.branchName}`)
  if (base === head) {
    // Nothing new since the last review (or nothing at all): the same verdict would come back.
    storage.taskAppendActivity(ticket.id, {
      kind: 'system',
      actorType: 'system',
      actorName: 'OperonSpec',
      body: rereview
        ? 'Moved to review with no new commits since the last review — the open points are still open.'
        : 'Moved to review with no commits — there is nothing to review yet.',
    })
    patchTicket(storage, spec.id, ticket.id, { state: 'building' })
    storage.taskUpdate(ticket.id, { status: 'in_progress' }, { type: 'system', name: 'OperonSpec' })
    broadcastTask(storage, ticket.id)
    if (ticket.bindingId != null) {
      await wakeTaskBinding(
        ticket.bindingId,
        `Ticket #${ticket.number} came back to review with no new commits on its branch. Commit your work, then call ` +
          `update_project_task(task: ${ticket.number}, status: "in_review").`,
      )
    }
    return null
  }

  const [design, tickets, diff, stat] = await Promise.all([
    readSpecFile(loc, SPEC_FILES.design),
    readSpecJson<SpecTicket[]>(loc, SPEC_FILES.tickets),
    getFileDiffRange(ticketWs.worktreePath, undefined, base, head),
    getDiffStatText(ticketWs.worktreePath, base, head),
  ])
  const spec_ticket = tickets?.find((t) => t.key === entry.key)
  if (!design || !spec_ticket) throw new Error(`spec #${spec.number} has lost its design or ticket ${entry.key}`)

  patchTicket(storage, spec.id, ticket.id, { reviewedSha: head })
  const config = storage.specRunGet(spec.id)?.config
  return agents.json<TicketReviewResult>(
    {
      label: `${rereview ? 're-review' : 'review'} ${entry.key} · ${entry.reviewer}`,
      phase: 'Build',
      seat: config ? seatFor(config, entry.reviewer) : { providerId: entry.reviewer },
      cwd: ticketWs.worktreePath,
      prompt: ticketReviewPrompt({
        design,
        ticket: spec_ticket,
        report: lastAgentReport(storage, ticket.id),
        diff,
        stat,
        openIssues: rereview ? entry.openIssues : undefined,
        crossFamily: familyOf(entry.implementer) !== familyOf(entry.reviewer),
      }),
    },
    TICKET_REVIEW_SCHEMA,
  )
}

/** The implementer's latest comment on its ticket — where it reports what it built. */
function lastAgentReport(storage: BuildStorage, taskId: number): string | null {
  const comments = storage.taskListActivity(taskId).filter((a) => a.kind === 'comment' && a.actorType === 'agent')
  return comments.at(-1)?.body ?? null
}

function formatIssue(issue: TicketReviewIssue): string {
  return `[${issue.severity}] ${issue.where} — ${issue.issue}`
}

async function settleReview(
  storage: BuildStorage,
  spec: Task,
  ticket: Task,
  entry: SpecTicketBuild,
  result: TicketReviewResult,
): Promise<void> {
  addRulings(storage, spec.id, entry.key, result.rulings)
  const blocking = result.issues.filter((i) => i.severity !== 'minor')
  const minor = result.issues.filter((i) => i.severity === 'minor')
  const comment = (body: string) =>
    storage.taskAppendActivity(ticket.id, {
      kind: 'comment',
      actorType: 'agent',
      actorId: null,
      actorName: `Reviewer · ${entry.reviewer}`,
      body,
    })

  // The design itself does not hold: stop starting tickets from it until a person looks.
  if (result.designBroken.trim()) {
    const reason = result.designBroken.trim()
    comment(`The design cannot be built as written:\n\n${reason}`)
    patchTicket(storage, spec.id, ticket.id, { state: 'blocked', blockedReason: `Design problem: ${reason}` })
    storage.specRunUpdate(spec.id, { stage: 'stopped', error: `Ticket ${entry.key}'s review found a problem in the design itself: ${reason}` })
    notifySpec(storage, spec, 'spec_blocked', `The design of #${spec.number} needs you — ${entry.key}: ${reason.slice(0, 140)}`)
    broadcastTask(storage, spec.id)
    return
  }

  if (blocking.length === 0) {
    comment(['Review passed.', ...(minor.length > 0 ? ['', 'Minor, not blocking:', ...minor.map((i) => `- ${formatIssue(i)}`)] : [])].join('\n'))
    patchTicket(storage, spec.id, ticket.id, { openIssues: undefined })
    const landed = await landSpecTicket(ticket.id, REVIEWER_ACTOR)
    if (!landed.ok && !('handedBack' in landed)) {
      await blockTicket(
        storage,
        spec,
        ticket.id,
        `Could not merge: ${landed.reason}`,
        `Ticket #${ticket.number} passed review but could not be merged: ${landed.reason}`,
      )
    }
    return
  }

  const round = entry.rounds + 1
  const issues = blocking.map(formatIssue)
  comment([`Review round ${round} asks for changes:`, ...issues.map((i) => `- ${i}`)].join('\n'))
  if (round >= MAX_REVIEW_ROUNDS) {
    patchTicket(storage, spec.id, ticket.id, { rounds: round, openIssues: issues })
    await blockTicket(
      storage,
      spec,
      ticket.id,
      `${round} review rounds did not pass. Still open: ${blocking[0].issue}`,
      `Ticket #${ticket.number} did not pass review after ${round} rounds`,
    )
    // A blocked ticket gives its slot back.
    await advance(storage, spec.id)
    return
  }
  patchTicket(storage, spec.id, ticket.id, { rounds: round, state: 'building', openIssues: issues })
  storage.taskUpdate(ticket.id, { status: 'in_progress' }, { type: 'system', name: 'OperonSpec' })
  broadcastTask(storage, ticket.id)
  broadcastTask(storage, spec.id)
  if (ticket.bindingId == null || !(await wakeTaskBinding(ticket.bindingId, reworkMessage(ticket.number, round, blocking)))) {
    const reason = 'Review asked for changes, but its implementer session could not be woken'
    await blockTicket(storage, spec, ticket.id, reason, `Ticket #${ticket.number}: ${reason}`)
  }
}

// ---------------------------------------------------------------------------
// Blocked
// ---------------------------------------------------------------------------

/**
 * Block a ticket. The spec's coordinator gets it first and the user only hears
 * of it when the coordinator cannot help: it already set this ticket going
 * MAX_COORDINATOR_RETRIES times, it cannot be woken, or its turn ends without
 * acting (onCoordinatorTurnEnded). `notice` is what the user is told.
 */
export async function blockTicket(storage: BuildStorage, spec: Task, taskId: number, reason: string, notice: string): Promise<void> {
  const entry = patchTicket(storage, spec.id, taskId, { state: 'blocked', blockedReason: reason, coordinator: undefined })
  broadcastTask(storage, spec.id)
  const retries = entry?.retries ?? 0
  if (entry && retries < MAX_COORDINATOR_RETRIES) {
    // Marked before the wake, so a coordinator that answers at once finds it asked.
    patchTicket(storage, spec.id, taskId, { coordinator: 'asked' })
    const ticket = storage.taskGet(taskId)
    const woke = await wakeCoordinator(
      storage,
      spec,
      blockedTicketMessage({
        specNumber: spec.number,
        ticketNumber: ticket?.number ?? 0,
        ticketKey: entry.key,
        reason,
        retriesLeft: MAX_COORDINATOR_RETRIES - retries,
      }),
    )
    if (woke) {
      storage.taskAppendActivity(spec.id, {
        kind: 'system',
        actorType: 'system',
        actorName: 'OperonSpec',
        body: `Ticket #${ticket?.number ?? entry.key} is blocked (${reason}). The coordinator is looking at it.`,
      })
      return
    }
    patchTicket(storage, spec.id, taskId, { coordinator: undefined })
  }
  notifySpec(storage, spec, 'spec_blocked', notice)
}

// ---------------------------------------------------------------------------
// The implementer's turn ended
// ---------------------------------------------------------------------------

/**
 * A ticket session's turn ended. Handing the ticket in (in_review) is how its
 * implementer says it is done; a turn that ends any other way would leave the
 * ticket "building" with nobody working on it. An error blocks it at once; a
 * quiet stop gets one reminder, and a second one blocks it.
 */
export async function onTicketTurnEnded(storage: BuildStorage, taskId: number, error?: string): Promise<void> {
  const found = ticketOf(storage, taskId)
  // Not a ticket: the spec's own session is its coordinator's.
  if (!found) return storage.specRunGet(taskId) ? onCoordinatorTurnEnded(storage, taskId, error) : undefined
  if (found.run.stage !== 'building' || found.entry.state !== 'building') return
  const { ticket, spec, entry } = found
  if (ticket.status !== 'in_progress') return
  const block = (reason: string) => blockTicket(storage, spec, taskId, reason, `Ticket #${ticket.number} stopped: ${reason}`)
  if (error) {
    await block(`Its session failed: ${error}`)
    await advance(storage, spec.id)
    return
  }
  if (entry.nudged) {
    await block('Its implementer stopped twice without handing the ticket in')
    await advance(storage, spec.id)
    return
  }
  patchTicket(storage, spec.id, taskId, { nudged: true })
  const woke =
    ticket.bindingId != null &&
    (await wakeTaskBinding(
      ticket.bindingId,
      `Your turn ended but ticket #${ticket.number} is still in progress. Nobody is watching this session to answer ` +
        'questions — decide anything small yourself and record it as a ruling. If the ticket is done, commit, post your ' +
        `report with comment_project_task and call update_project_task(task: ${ticket.number}, status: "in_review"). ` +
        'If it truly cannot be finished, say why in a comment and stop.',
    ))
  if (!woke) await block('Its implementer session ended and could not be woken')
}

// ---------------------------------------------------------------------------
// Merged, sent back
// ---------------------------------------------------------------------------

/**
 * A ticket landed on the change branch — by review or by a person's Done. Start
 * what it unblocked; once every ticket is in, the change as a whole goes to review.
 */
export async function onTicketLanded(storage: BuildStorage, specId: number, taskId: number): Promise<void> {
  patchTicket(storage, specId, taskId, { state: 'merged', openIssues: undefined, blockedReason: undefined, coordinator: undefined })
  const children = storage.taskListChildren(specId)
  if (children.every((c) => c.status === 'done' || c.status === 'cancelled')) {
    // The whole change is in: review it as one before the user signs it.
    if ((storage.specRunGet(specId)?.build.length ?? 0) > 0) {
      onAllTicketsMerged(storage, specId)
      return
    }
    // A spec approved before the build stage existed has no review stage either.
    const spec = storage.taskGet(specId)
    if (spec && spec.status !== 'in_review' && spec.status !== 'done') {
      storage.taskUpdate(specId, { status: 'in_review' }, { type: 'system', name: 'system' })
    }
    storage.taskAppendActivity(specId, {
      kind: 'system',
      actorType: 'system',
      actorName: 'system',
      body: 'All tickets are merged into the change branch. Review it, then mark Done to merge the change into the default branch.',
      meta: {},
    })
    broadcastTask(storage, specId)
    return
  }
  broadcastTask(storage, specId)
  await advance(storage, specId)
}

/**
 * Merging a reviewed ticket conflicted and it went back to its implementer.
 * The resolution is reviewed afresh (the whole ticket against the change
 * branch), since a merge can drop either side's work.
 */
export function onTicketSentBack(storage: BuildStorage, specId: number, taskId: number): void {
  patchTicket(storage, specId, taskId, { state: 'building', reviewedSha: undefined, openIssues: undefined })
  broadcastTask(storage, specId)
}

// ---------------------------------------------------------------------------
// Resume, stop, restart
// ---------------------------------------------------------------------------

/** Whether ticket reviews of this spec are executing in this process. */
export function isBuildActive(specId: number): boolean {
  return (sessions.get(specId)?.active ?? 0) > 0
}

export function stopBuild(specId: number): boolean {
  const session = sessions.get(specId)
  if (!session || session.active === 0) return false
  session.stop()
  return true
}

/**
 * Carry a paused build on: review every ticket that is waiting for one (in
 * review, or cut short by a stop or a restart), then start the frontier.
 */
export async function resumeBuild(storage: BuildStorage, specId: number): Promise<void> {
  const before = storage.specRunGet(specId)
  // Everything merged already: what stopped was the review of the whole change.
  const children = storage.taskListChildren(specId)
  if ((before?.build.length ?? 0) > 0 && children.length > 0 && children.every((c) => c.status === 'done' || c.status === 'cancelled')) {
    onAllTicketsMerged(storage, specId)
    return
  }
  storage.specRunUpdate(specId, { stage: 'building', error: null })
  broadcastTask(storage, specId)
  const run = storage.specRunGet(specId)
  for (const entry of run?.build ?? []) {
    const task = storage.taskGet(entry.taskId)
    const waitingForReview = entry.state === 'reviewing' || (entry.state === 'building' && task?.status === 'in_review')
    if (waitingForReview && !reviewing.has(entry.taskId)) onTicketInReview(storage, entry.taskId)
  }
  await advance(storage, specId)
}

/**
 * At startup: building and reviewing specs carry on where the restart left them.
 * A restart kills every running session, so tickets that were being built are
 * woken to pick up from their worktree — otherwise they would sit "building"
 * with nobody at work.
 */
export async function sweepBuilds(storage: BuildStorage): Promise<void> {
  for (const run of storage.specRunList(['building', 'reviewing'])) {
    for (const entry of run.build) {
      const task = storage.taskGet(entry.taskId)
      if (entry.state !== 'building' || task?.status !== 'in_progress' || task.bindingId == null) continue
      await wakeTaskBinding(
        task.bindingId,
        `The app restarted while you were working on ticket #${task.number}, and your session was cut off. Check your ` +
          'worktree (git status, git log) to see how far you got, then carry on from there. When it is done: commit, post ' +
          `your report with comment_project_task and call update_project_task(task: ${task.number}, status: "in_review").`,
      ).catch(() => false)
    }
    try {
      await resumeBuild(storage, run.taskId)
    } catch (err) {
      console.error(`[Spec] could not resume the build of spec task ${run.taskId}:`, err)
    }
  }
  // The coordinator's session was cut off too, maybe in the middle of what it was asked.
  for (const run of storage.specRunList(['building', 'integrating'])) {
    const spec = storage.taskGet(run.taskId)
    const asked = run.build.filter((b) => b.state === 'blocked' && b.coordinator === 'asked')
    if (!spec || (run.stage !== 'integrating' && asked.length === 0)) continue
    const numbers = asked.map((b) => `#${storage.taskGet(b.taskId)?.number ?? b.key}`)
    const message =
      run.stage === 'integrating'
        ? `The app restarted while you were resolving the sign-off conflict of spec #${spec.number}, and your session was cut off. ` +
          `Check your worktree (git status) and carry on; when the merge is committed, call spec_integration_done(task: ${spec.number}, summary: ...).`
        : `The app restarted and cut your session off. Tickets of spec #${spec.number} still blocked and waiting on you: ${numbers.join(', ')}. ` +
          `Check spec_status(task: ${spec.number}) and carry on.`
    await wakeCoordinator(storage, spec, message).catch(() => false)
  }
}

// ---------------------------------------------------------------------------
// Recording reviews in the spec's workflow run
// ---------------------------------------------------------------------------

/**
 * One open segment of the spec's workflow run, shared by every review running
 * at once (so their agent rows get distinct indices), settled when the last
 * one finishes.
 */
export class BuildSession {
  active = 0
  stopped = false
  /** Handed back to the chat that started the spec when this segment settles (gate 2 is ready, say). */
  private result: unknown = undefined
  private controller = new AbortController()
  private writer: RunEventWriter | null = null
  private agents: SpecAgents | null = null

  constructor(
    private readonly storage: BuildStorage,
    private readonly spec: Task,
  ) {}

  async run<T>(fn: (agents: SpecAgents) => Promise<T>): Promise<T> {
    const agents = this.open()
    this.active++
    try {
      return await fn(agents)
    } finally {
      if (--this.active === 0) this.close()
    }
  }

  stop(): void {
    this.stopped = true
    this.controller.abort()
  }

  /** Report `result` to the spec's chat when this segment settles, as a design run reports its end. */
  deliver(result: unknown): void {
    this.result = result
  }

  private open(): SpecAgents {
    if (this.agents) return this.agents
    const run = this.storage.specRunGet(this.spec.id)
    const previous = run?.workflowRunId ? readRunView(run.workflowRunId) : undefined
    if (!run?.workflowRunId) throw new Error(`spec #${this.spec.number} has no workflow run to record into`)
    const runId = run.workflowRunId
    appendEvent(runId, {
      kind: 'started',
      chatId: this.spec.sourceChatId,
      name: `OperonSpec #${this.spec.number}`,
      description: this.spec.title,
      script: '',
      startedAt: Date.now(),
      ...(previous ? { resumed: true } : {}),
    })
    const writer = new RunEventWriter(runId)
    markExecuting(runId)
    registerWorkflowAbort(runId, this.controller)
    writer.emit({ kind: 'phase', index: 0, title: 'Build' })
    const firstIndex = (previous?.agents ?? []).reduce((max, a) => Math.max(max, a.index + 1), 0)
    const specWs = this.spec.workspaceId != null ? this.storage.getWorkspace(this.spec.workspaceId) : null
    this.writer = writer
    this.agents = new SpecAgents({
      writer,
      cwd: specWs?.worktreePath ?? '',
      chatId: this.spec.sourceChatId,
      workspaceId: this.spec.workspaceId ?? null,
      signal: this.controller.signal,
      firstIndex,
    })
    return this.agents
  }

  private close(): void {
    const writer = this.writer
    this.writer = null
    this.agents = null
    if (sessions.get(this.spec.id) === this) sessions.delete(this.spec.id)
    if (!writer) return
    const result = this.stopped ? undefined : this.result
    appendEvent(writer.runId, {
      kind: 'settled',
      status: this.stopped ? 'stopped' : 'completed',
      endedAt: Date.now(),
      ...(result !== undefined ? { result } : {}),
    })
    writer.dispose()
    unregisterWorkflowAbort(writer.runId)
    unmarkExecuting(writer.runId)
    if (result !== undefined) {
      const view = readRunView(writer.runId)
      if (view) void deliverWorkflowResult(view)
    }
  }
}

const sessions = new Map<number, BuildSession>()

export function sessionFor(storage: BuildStorage, spec: Task): BuildSession {
  let session = sessions.get(spec.id)
  if (!session) sessions.set(spec.id, (session = new BuildSession(storage, spec)))
  return session
}

// ---------------------------------------------------------------------------
// Telling the user
// ---------------------------------------------------------------------------

/**
 * A person acted on what a spec notification asked for — signed or sent back
 * gate 2, got a stuck ticket moving — so the row stops asking. Same as an
 * answered approval: marked read, kept in the inbox's history.
 */
export function settleSpecNotice(storage: NotificationStorageAdapter, specId: number, kind: 'spec_gate' | 'spec_blocked'): void {
  try {
    const readIds = storage.notificationMarkReadBySource(`spec:${specId}`, kind)
    for (const id of readIds) {
      const row = storage.notificationGet(id)
      if (row) emitInboxEvent({ type: 'notification_upsert', notification: row })
    }
    if (readIds.length > 0) emitCounts(storage)
  } catch (err) {
    console.error(`[Spec] could not settle the ${kind} notice of spec task ${specId}:`, err)
  }
}

export function notifySpec(storage: BuildStorage, spec: Task, kind: 'spec_gate' | 'spec_blocked', body: string): void {
  notify(storage, {
    kind,
    severity: 'action',
    sourceKey: `spec:${spec.id}`,
    projectId: spec.projectId,
    taskId: spec.id,
    title: spec.title,
    body,
  })
}
