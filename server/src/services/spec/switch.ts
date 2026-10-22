/**
 * Moving a role of a spec to another agent — at any step, because any step can
 * hit an agent out of quota, one that will not log in, a provider having a bad
 * day.
 *
 *   design stage (no coordinator yet) → the user switches a role on the spec
 *                                       panel (or tells the spec's chat) and the
 *                                       run resumes on the new agent
 *   build stage                       → the coordinator proposes a switch
 *                                       (spec_propose_switch), the user says yes
 *                                       on the panel or in the spec's chat
 *
 * A running agent of the design stage is handed off live from the Workflow panel
 * instead (`replaceLiveAgent`); this is for the seats between and after runs.
 */

import type { Task, TaskActor } from '../../types/task.js'
import {
  DESIGN_ROLES,
  type SpecRun,
  type SpecRunConfig,
  type SpecSeat,
  type SpecSeatView,
  type SpecSwitch,
  type SpecSwitchProposal,
  type SpecTicketBuild,
} from '../../types/spec.js'
import { detachTaskSession } from '../channel/agent-orchestrator.js'
import { broadcastTask } from '../task-events.js'
import { getOrCreateSpecBuilder } from './builders.js'
import {
  advance,
  builderFields,
  endTicketRow,
  isTicketUnderReview,
  notifySpec,
  patchTicket,
  reviewerSeat,
  settleSpecNotice,
  type BuildStorage,
} from './build-run.js'
import { coordinatorSeat, reviewerFor, withBuildDefaults } from './config.js'
import { coordinatorBinding, ensureCoordinator, settleFailure, wakeCoordinator } from './coordinator.js'
import { isDesignRunActive } from './design-run.js'
import { SpecError, resumeSpec } from './spec-service.js'
import { usableProviders } from './role-settings.js'

/** `codex`, or `opencode · vendor/model`. */
export function seatName(seat: SpecSeat | null | undefined): string {
  if (!seat) return '—'
  return seat.modelId ? `${seat.providerId} · ${seat.modelId}` : seat.providerId
}

function sameSeat(a: SpecSeat | null, b: SpecSeat): boolean {
  return a != null && a.providerId === b.providerId && (a.modelId ?? '') === (b.modelId ?? '')
}

/** 'the reviewer of T2', 'candidate B', 'the lead'. */
export function roleName(sw: Pick<SpecSwitch, 'role' | 'index' | 'ticketKey'>): string {
  if (sw.role === 'candidate') return `candidate ${String.fromCharCode(65 + (sw.index ?? 0))}`
  return sw.ticketKey ? `the ${sw.role} of ${sw.ticketKey}` : `the ${sw.role}`
}


/** Every seat a person can switch, as the panel lists them. Pure, for tests. */
export function specSeats(config: SpecRunConfig, build: readonly SpecTicketBuild[]): SpecSeatView[] {
  const full = withBuildDefaults(config)
  const seats: SpecSeatView[] = [
    { role: 'lead', seat: full.lead },
    { role: 'explorer', seat: full.explorer },
    ...full.candidates.map((seat, index) => ({ role: 'candidate' as const, index, seat })),
    { role: 'judge', seat: full.judge },
    { role: 'builder', seat: full.builder },
    { role: 'implementer', seat: full.implementer },
    full.reviewer
      ? { role: 'reviewer', seat: full.reviewer }
      : { role: 'reviewer', seat: { providerId: reviewerFor(full, full.implementer.providerId) }, auto: true },
    { role: 'coordinator', seat: coordinatorSeat(full) },
  ]
  for (const entry of build) {
    if (entry.state === 'merged') continue
    seats.push(
      { role: 'implementer', ticketKey: entry.key, seat: implementerSeat(entry) },
      { role: 'reviewer', ticketKey: entry.key, seat: reviewerSeat(full, entry) },
    )
  }
  return seats
}

function implementerSeat(entry: SpecTicketBuild): SpecSeat {
  return entry.implementerModelId ? { providerId: entry.implementer, modelId: entry.implementerModelId } : { providerId: entry.implementer }
}

/** Who plays a role now; null when the switch names a seat the spec does not have. */
export function seatOf(run: SpecRun, sw: Pick<SpecSwitch, 'role' | 'index' | 'ticketKey'>): SpecSeat | null {
  const config = withBuildDefaults(run.config)
  if (sw.ticketKey) {
    const entry = run.build.find((b) => b.key === sw.ticketKey)
    if (!entry || (sw.role !== 'implementer' && sw.role !== 'reviewer')) return null
    return sw.role === 'implementer' ? implementerSeat(entry) : reviewerSeat(config, entry)
  }
  switch (sw.role) {
    case 'candidate':
      return config.candidates[sw.index ?? -1] ?? null
    case 'reviewer':
      return config.reviewer ?? null
    case 'coordinator':
      return coordinatorSeat(config)
    default:
      return config[sw.role]
  }
}

/** The switch in a form that can be applied here, or why not. */
function validate(run: SpecRun, spec: Task, sw: SpecSwitch): { to: SpecSeat; from: SpecSeat | null } {
  if (run.stage === 'done') throw new SpecError(`Spec #${spec.number} is done; there is nothing left to switch`)
  const providerId = sw.to.providerId?.trim()
  if (!providerId) throw new SpecError('Say which agent to switch to')
  if (!usableProviders().includes(providerId)) throw new SpecError(`${providerId} is not installed or usable here`)
  const to: SpecSeat = sw.to.modelId?.trim() ? { providerId, modelId: sw.to.modelId.trim() } : { providerId }
  if (sw.ticketKey) {
    if (sw.role !== 'implementer' && sw.role !== 'reviewer') throw new SpecError(`A ticket has an implementer and a reviewer, not a ${sw.role}`)
    const entry = run.build.find((b) => b.key === sw.ticketKey)
    if (!entry) throw new SpecError(`Spec #${spec.number} has no ticket ${sw.ticketKey}`)
    if (entry.state === 'merged') throw new SpecError(`${sw.ticketKey} is already merged`)
    if (isTicketUnderReview(entry.taskId)) {
      throw new SpecError(`${sw.ticketKey} is being reviewed right now; switch it once the review is back (or stop the spec first)`)
    }
  }
  if (sw.role === 'candidate' && !(Number.isInteger(sw.index) && (sw.index as number) >= 0 && (sw.index as number) < run.config.candidates.length)) {
    throw new SpecError(`Spec #${spec.number} has ${run.config.candidates.length} candidates; say which one`)
  }
  if (DESIGN_ROLES.includes(sw.role) && isDesignRunActive(spec.id)) {
    throw new SpecError(
      `The design of #${spec.number} is running. Hand the running agent to another one from the Workflow panel, or stop the spec first.`,
    )
  }
  return { to, from: seatOf(run, sw) }
}

/**
 * Give a ticket to the agent on `to`. Whatever its old agent was doing stops and
 * its row in the run ends; the ticket goes back to the front of the queue with
 * its worktree as it is, and the new agent is told to build on it. Waiting
 * tickets just change hands.
 */
async function reassignTicket(storage: BuildStorage, spec: Task, entry: SpecTicketBuild, config: SpecRunConfig, to: SpecSeat): Promise<void> {
  const ticket = storage.taskGet(entry.taskId)
  if (!ticket) throw new SpecError(`Ticket ${entry.key} is gone`)
  const agent = getOrCreateSpecBuilder(storage, to)
  const underway = entry.state !== 'waiting'
  endTicketRow(spec.id, ticket.id, { error: `Handed to ${seatName(to)}` })
  if (ticket.bindingId != null) await detachTaskSession(ticket.id)
  storage.taskUpdate(ticket.id, { assignedAgentId: agent.id, ...(underway ? { status: 'todo' } : {}) }, { type: 'system', name: 'OperonSpec' })
  const fields = builderFields(config, to)
  patchTicket(storage, spec.id, ticket.id, {
    implementer: fields.implementer,
    implementerModelId: fields.implementerModelId,
    // A reviewer picked for this ticket (with its model) stays; an automatic one follows the new builder's family.
    ...(entry.reviewerModelId ? {} : { reviewer: fields.reviewer, reviewerModelId: fields.reviewerModelId }),
    state: 'waiting',
    rounds: 0,
    retries: 0,
    nudged: undefined,
    coordinator: undefined,
    blockedReason: undefined,
    ...(underway ? { handedOver: seatName(implementerSeat(entry)) } : {}),
  })
  if (entry.state === 'blocked') settleSpecNotice(storage, spec.id, 'spec_blocked')
  broadcastTask(storage, ticket.id)
}

/** The coordinator moves to its new seat: a new session, told what is still on its plate. */
async function replaceCoordinator(storage: BuildStorage, spec: Task): Promise<void> {
  if (!coordinatorBinding(storage, spec)) return // none yet: it starts on the new seat
  await detachTaskSession(spec.id)
  const fresh = storage.taskGet(spec.id)
  const run = fresh ? storage.specRunGet(spec.id) : null
  if (!fresh || !run) return
  await ensureCoordinator(storage, fresh)
  const asked = run.build.filter((b) => b.state === 'blocked' && b.coordinator === 'asked')
  if (run.stage !== 'integrating' && asked.length === 0) return
  const numbers = asked.map((b) => `#${storage.taskGet(b.taskId)?.number ?? b.key}`)
  await wakeCoordinator(
    storage,
    fresh,
    `You are taking over as the coordinator of spec #${spec.number} from another agent. ` +
      (run.stage === 'integrating'
        ? `It was resolving a sign-off conflict: check the worktree (git status) and carry on; when the merge is committed, call spec_integration_done(task: ${spec.number}, summary: ...).`
        : `Tickets still blocked and waiting on the coordinator: ${numbers.join(', ')}. Check spec_status(task: ${spec.number}) and carry on.`),
  ).catch(() => false)
}

/**
 * Switch a role to another agent. The spec's seat changes for what runs next; a
 * ticket's switch hands the ticket over at once. A stopped or failed spec
 * carries on with the new agent (`resume: false` leaves it stopped). Returns
 * what happened, in a sentence.
 */
export async function switchSpecSeat(
  storage: BuildStorage,
  specId: number,
  sw: SpecSwitch,
  actor: TaskActor,
  opts: { resume?: boolean } = {},
): Promise<string> {
  const spec = storage.taskGet(specId)
  const run = spec ? storage.specRunGet(specId) : null
  if (!spec || !run) throw new SpecError(`Task ${specId} is not an OperonSpec`)
  const { to, from } = validate(run, spec, sw)
  if (sameSeat(from, to)) throw new SpecError(`${roleName(sw)} is already ${seatName(to)}`)

  // The spec's seats first: what happens next (a coordinator's new session, a ticket's builder) reads them.
  const config: SpecRunConfig = { ...run.config, candidates: [...run.config.candidates] }
  const signed = run.designSha != null
  if (!sw.ticketKey) {
    if (sw.role === 'candidate') config.candidates[sw.index as number] = to
    else config[sw.role] = to
  }
  storage.specRunUpdate(spec.id, { config, proposal: null })
  settleSpecNotice(storage, spec.id, 'spec_blocked')
  const built = withBuildDefaults(config)

  if (sw.ticketKey) {
    const entry = run.build.find((b) => b.key === sw.ticketKey) as SpecTicketBuild
    if (sw.role === 'implementer') await reassignTicket(storage, spec, entry, built, to)
    else patchTicket(storage, spec.id, entry.taskId, { reviewer: to.providerId, reviewerModelId: to.modelId })
  } else if (signed && sw.role === 'implementer') {
    // The spec's builder: every ticket not started yet goes to it too.
    for (const entry of run.build.filter((b) => b.state === 'waiting')) await reassignTicket(storage, spec, entry, built, to)
  } else if (signed && sw.role === 'reviewer') {
    for (const entry of run.build.filter((b) => b.state !== 'merged' && !isTicketUnderReview(b.taskId))) {
      patchTicket(storage, spec.id, entry.taskId, { reviewer: to.providerId, reviewerModelId: to.modelId })
    }
  } else if (sw.role === 'coordinator') {
    await replaceCoordinator(storage, spec)
  }

  storage.taskAppendActivity(spec.id, {
    kind: 'system',
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    body: `Switched ${roleName(sw)} from ${seatName(from)} to ${seatName(to)}`,
  })

  const stage = storage.specRunGet(spec.id)?.stage
  let carriedOn = ''
  if (opts.resume !== false && (stage === 'stopped' || stage === 'failed')) {
    await resumeSpec(storage, spec.id)
    carriedOn = ' The spec carries on.'
  } else if (stage === 'building') {
    // A ticket handed over starts again as soon as there is a slot.
    await advance(storage, spec.id)
  }
  broadcastTask(storage, spec.id)
  return `Switched ${roleName(sw)} to ${seatName(to)}.${carriedOn}`
}

// ---------------------------------------------------------------------------
// The coordinator asks; the user decides
// ---------------------------------------------------------------------------

/** spec_propose_switch: the coordinator asks the user to move a role to another agent. */
export function proposeSwitch(storage: BuildStorage, spec: Task, sw: SpecSwitch, reason: string, actorName: string): string {
  const run = storage.specRunGet(spec.id)
  if (!run) throw new SpecError(`#${spec.number} is not a spec`)
  const why = reason.trim()
  if (!why) throw new SpecError('Say why the switch is needed')
  const { to, from } = validate(run, spec, sw)
  if (sameSeat(from, to)) throw new SpecError(`${roleName(sw)} is already ${seatName(to)}`)
  const proposal: SpecSwitchProposal = {
    role: sw.role,
    ...(sw.index != null ? { index: sw.index } : {}),
    ...(sw.ticketKey ? { ticketKey: sw.ticketKey } : {}),
    to,
    from,
    reason: why,
    proposedAt: Date.now(),
  }
  storage.specRunUpdate(spec.id, { proposal })
  settleFailure(spec.id)
  const body = `Proposes switching ${roleName(sw)} from ${seatName(from)} to ${seatName(to)}: ${why}`
  storage.taskAppendActivity(spec.id, { kind: 'comment', actorType: 'agent', actorId: null, actorName, body })
  notifySpec(storage, spec, 'spec_blocked', `The coordinator of #${spec.number} asks to switch ${roleName(sw)} from ${seatName(from)} to ${seatName(to)}: ${why}`)
  broadcastTask(storage, spec.id)
  return (
    'Asked the user. If they agree, the switch is made and the work carries on on the new agent — nothing more for you to do. ' +
    `If they decline or want something else, their answer comes back to you as a message on spec #${spec.number}. End your turn.`
  )
}

/** The user said yes to the coordinator's proposal. */
export async function acceptSwitchProposal(storage: BuildStorage, specId: number, actor: TaskActor): Promise<string> {
  const proposal = storage.specRunGet(specId)?.proposal
  if (!proposal) throw new SpecError('There is no switch waiting for an answer')
  return switchSpecSeat(storage, specId, proposal, actor)
}

/** The user said no: the coordinator hears so and decides what else to do. */
export async function dismissSwitchProposal(storage: BuildStorage, specId: number, actor: TaskActor, note?: string): Promise<void> {
  const spec = storage.taskGet(specId)
  const proposal = spec ? storage.specRunGet(specId)?.proposal : null
  if (!spec || !proposal) throw new SpecError('There is no switch waiting for an answer')
  storage.specRunUpdate(specId, { proposal: null })
  settleSpecNotice(storage, specId, 'spec_blocked')
  const body = `Declined switching ${roleName(proposal)} to ${seatName(proposal.to)}${note?.trim() ? `: ${note.trim()}` : ''}`
  storage.taskAppendActivity(specId, { kind: 'comment', actorType: actor.type, actorId: actor.id, actorName: actor.name, body })
  broadcastTask(storage, specId)
  await wakeCoordinator(
    storage,
    spec,
    `The user declined switching ${roleName(proposal)} to ${seatName(proposal.to)}${note?.trim() ? `, saying: ${note.trim()}` : ''}. ` +
      `Decide what else to do (spec_status(task: ${spec.number})), or leave it with them via spec_escalate.`,
  ).catch(() => false)
}
