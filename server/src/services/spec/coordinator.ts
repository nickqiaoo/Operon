/**
 * The spec's coordinator: one agent session per spec that takes what the build's
 * rules cannot — a stuck ticket, a conflict at sign-off, a comment the user
 * leaves on the spec.
 *
 * The build itself stays deterministic (build-run.ts, review-run.ts). The
 * coordinator is woken by events, never loops: it lives as a task binding on the
 * spec, in the spec's change worktree, so its session survives restarts and a
 * comment on the spec reaches it like a comment on any dispatched task. It acts
 * through the taskboard tools below, which only it may call for its spec.
 *
 *   ticket blocked     → coordinator: retry with instructions / add a ticket / escalate;
 *                        a turn that ends without any of them tells the user
 *   sign-off conflict  → stage integrating; it merges and resolves on the change branch,
 *                        hands in, and a reviewer from another family checks the result
 */

import type { AgentBinding } from '../../types/agent-binding.js'
import type { Task } from '../../types/task.js'
import type { SpecCoordinatorView, SpecIntegration, SpecTicket, SpecTicketBuild } from '../../types/spec.js'
import { attachSpecCoordinator, dispatchProjectTask, wakeTaskBinding } from '../channel/agent-orchestrator.js'
import { excludeLocally, getStatus, isAncestor, isMerging } from '../git.js'
import { broadcastTask } from '../task-events.js'
import { getOrCreateSpecCoordinator } from './builders.js'
import { coordinatorSeat } from './config.js'
import { SPEC_FILES, readSpecJson, specDir, writeSpecFiles, type SpecLocation } from './files.js'
import { MAX_COORDINATOR_RETRIES, stepFailedMessage } from './prompts.js'
import { addRulings, addTicket, advance, notifySpec, patchTicket, type BuildStorage } from './build-run.js'
import { onAllTicketsMerged } from './review-run.js'
import { SpecError } from './spec-service.js'

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/** The spec's coordinator session, once it has one. */
export function coordinatorBinding(storage: BuildStorage, spec: Task): AgentBinding | null {
  if (spec.bindingId == null) return null
  const binding = storage.getBinding(spec.bindingId)
  return binding?.scopeKind === 'task' && binding.scopeKey === String(spec.id) ? binding : null
}

/**
 * Give the spec its coordinator, on the lead's seat. Idempotent. Null when it
 * cannot have one: no change worktree, or a provider that cannot run unattended.
 */
export async function ensureCoordinator(storage: BuildStorage, spec: Task): Promise<AgentBinding | null> {
  const existing = coordinatorBinding(storage, spec)
  if (existing) return existing
  const run = storage.specRunGet(spec.id)
  const ws = spec.workspaceId != null ? storage.getWorkspace(spec.workspaceId) : null
  if (!run || !ws) return null
  try {
    const agent = getOrCreateSpecCoordinator(storage, coordinatorSeat(run.config))
    // Agents keep notes in .agent-memory/; on the change branch they would be committed with the change.
    await excludeLocally(ws.worktreePath, '.agent-memory/').catch(() => undefined)
    return attachSpecCoordinator(spec.id, agent.id)
  } catch (err) {
    console.error(`[Spec] spec #${spec.number} gets no coordinator:`, err)
    return null
  }
}

/** Wake the spec's coordinator with a message. False when it has none or could not be woken. */
export async function wakeCoordinator(storage: BuildStorage, spec: Task, message: string): Promise<boolean> {
  const binding = await ensureCoordinator(storage, spec)
  if (!binding) return false
  return wakeTaskBinding(binding.id, message)
}

/**
 * A step of the build or review stopped on an error (the spec is now failed).
 * The coordinator looks first — the usual cause is the agent (quota, auth, a
 * provider error), and it can ask the user to switch; without one the user is
 * told directly.
 */
export async function onStepFailed(
  storage: BuildStorage,
  spec: Task,
  step: string,
  reason: string,
  role?: { role: string; ticketNumber?: number },
): Promise<void> {
  const woke = await wakeCoordinator(
    storage,
    spec,
    stepFailedMessage({ specNumber: spec.number, step, reason, role: role?.role, ticketNumber: role?.ticketNumber }),
  ).catch(() => false)
  if (!woke) notifySpec(storage, spec, 'spec_blocked', `#${spec.number} stopped: ${step} failed — ${reason}`.slice(0, 280))
}

export function isCoordinatorOf(storage: BuildStorage, spec: Task, agentId: number): boolean {
  return coordinatorBinding(storage, spec)?.agentId === agentId
}

export function coordinatorView(storage: BuildStorage, spec: Task): SpecCoordinatorView | null {
  const binding = coordinatorBinding(storage, spec)
  const agent = binding ? storage.getAgent(binding.agentId) : null
  if (!binding || !agent) return null
  return {
    agentName: agent.name,
    providerId: agent.provider,
    ...(agent.model ? { modelId: agent.model } : {}),
    status: binding.status === 'completed' ? 'idle' : binding.status,
    chatId: binding.activeChatId ?? null,
    workspaceId: binding.workspaceId ?? null,
  }
}


// ---------------------------------------------------------------------------
// Its turn ended
// ---------------------------------------------------------------------------

/**
 * The coordinator's turn ended. Whatever it was asked about and left as it was
 * now goes to the user: a blocked ticket it neither retried nor escalated, a
 * sign-off conflict it did not hand in.
 */
export async function onCoordinatorTurnEnded(storage: BuildStorage, specId: number, error?: string): Promise<void> {
  const spec = storage.taskGet(specId)
  const run = spec ? storage.specRunGet(specId) : null
  if (!spec || !run) return
  const why = error ? ` (its session failed: ${error})` : ''
  for (const entry of run.build) {
    if (entry.state !== 'blocked' || entry.coordinator !== 'asked') continue
    patchTicket(storage, specId, entry.taskId, { coordinator: 'escalated' })
    const ticket = storage.taskGet(entry.taskId)
    notifySpec(
      storage,
      spec,
      'spec_blocked',
      `Ticket #${ticket?.number ?? entry.key} is blocked and the coordinator did not move it${why}: ${entry.blockedReason ?? ''}`.trim(),
    )
    broadcastTask(storage, specId)
  }
  if (run.stage === 'integrating') {
    const integration = await readIntegration(storage, spec)
    if (integration && !integration.summary) {
      notifySpec(
        storage,
        spec,
        'spec_blocked',
        `The coordinator stopped before resolving the sign-off conflict of #${spec.number}${why}. Comment on the spec to set it going again, or request changes.`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// What it can do — the taskboard tools
// ---------------------------------------------------------------------------

function locationOf(storage: BuildStorage, spec: Task): SpecLocation {
  const ws = spec.workspaceId != null ? storage.getWorkspace(spec.workspaceId) : null
  if (!ws) throw new SpecError(`Spec #${spec.number} has lost its change worktree`)
  return { taskId: spec.id, taskNumber: spec.number, worktreePath: ws.worktreePath }
}

async function readIntegration(storage: BuildStorage, spec: Task): Promise<SpecIntegration | null> {
  const ws = spec.workspaceId != null ? storage.getWorkspace(spec.workspaceId) : null
  if (!ws) return null
  return readSpecJson<SpecIntegration>({ taskId: spec.id, taskNumber: spec.number, worktreePath: ws.worktreePath }, SPEC_FILES.integration)
}

function entryFor(storage: BuildStorage, spec: Task, ticketNumber: number): { entry: SpecTicketBuild; ticket: Task } {
  const run = storage.specRunGet(spec.id)
  const ticket = storage.taskGetByNumber(spec.projectId, ticketNumber)
  const entry = ticket ? run?.build.find((b) => b.taskId === ticket.id) : undefined
  if (!ticket || !entry) throw new SpecError(`#${ticketNumber} is not a ticket of spec #${spec.number}`)
  return { entry, ticket }
}

/** spec_status: where the spec and every ticket stand, as text for an agent. */
export async function specStatus(storage: BuildStorage, spec: Task): Promise<string> {
  const run = storage.specRunGet(spec.id)
  if (!run) throw new SpecError(`#${spec.number} is not a spec`)
  const lines = [
    `# Spec #${spec.number}: ${spec.title}`,
    `stage=${run.stage}${run.error ? ` (${run.error})` : ''}; change branch \`${spec.branchName ?? '?'}\`; files in \`${specDir(spec.number)}/\``,
  ]
  if (run.build.length > 0) {
    lines.push('', '## Tickets')
    for (const b of run.build) {
      const task = storage.taskGet(b.taskId)
      const parts = [`${b.key} #${task?.number ?? '?'} "${task?.title ?? ''}" — ${b.state}`, `${b.implementer} → ${b.reviewer}`]
      if (b.rounds > 0) parts.push(`${b.rounds} review round(s) sent back`)
      if (b.retries) parts.push(`retried ${b.retries}/${MAX_COORDINATOR_RETRIES}`)
      if (b.state === 'blocked' && b.blockedReason) parts.push(`blocked: ${b.blockedReason}`)
      lines.push(`- ${parts.join('; ')}`)
      for (const issue of b.openIssues ?? []) lines.push(`  - open: ${issue}`)
    }
  }
  if (run.rulings.length > 0) {
    lines.push('', '## Rulings', ...run.rulings.map((r) => `- ${r.ticketKey}: ${r.ruling}`))
  }
  if (run.stage === 'integrating') {
    const integration = await readIntegration(storage, spec)
    if (integration) {
      lines.push('', '## Sign-off conflict', `merging \`${integration.target}\` conflicted in ${integration.files.join(', ') || 'some files'}`)
    }
  }
  return lines.join('\n')
}

/**
 * spec_retry_ticket: set a blocked ticket going again with the coordinator's
 * instructions — in its implementer's own session, which knows the code. Its
 * review rounds start over; the open issues stay for the next review to check.
 */
export async function retryTicket(
  storage: BuildStorage,
  spec: Task,
  input: { ticket: number; instructions: string; ruling?: string },
  actorName: string,
): Promise<string> {
  const run = storage.specRunGet(spec.id)
  if (run?.stage !== 'building') throw new SpecError(`Spec #${spec.number} is ${run?.stage ?? 'not a spec'}; tickets move only while it is building`)
  const { entry, ticket } = entryFor(storage, spec, input.ticket)
  if (entry.state !== 'blocked') throw new SpecError(`Ticket #${ticket.number} is ${entry.state}, not blocked`)
  const retries = entry.retries ?? 0
  if (retries >= MAX_COORDINATOR_RETRIES) {
    throw new SpecError(`Ticket #${ticket.number} was already retried ${retries} times. Hand it to the user with spec_escalate.`)
  }
  const instructions = input.instructions.trim()
  if (!instructions) throw new SpecError('Say what the implementer should do differently')
  if (input.ruling?.trim()) addRulings(storage, spec.id, entry.key, [input.ruling.trim()])

  patchTicket(storage, spec.id, ticket.id, {
    state: 'building',
    rounds: 0,
    retries: retries + 1,
    blockedReason: undefined,
    coordinator: undefined,
    nudged: undefined,
  })
  storage.taskAppendActivity(ticket.id, { kind: 'comment', actorType: 'agent', actorId: null, actorName, body: instructions })
  const message =
    `The spec's coordinator looked at why ticket #${ticket.number} got stuck and says:\n\n${instructions}\n\n` +
    'Carry on from your worktree (check git status first). When it is done: commit, post your report with ' +
    `comment_project_task and call update_project_task(task: ${ticket.number}, status: "in_review").`
  let started = false
  if (ticket.bindingId != null && ticket.workspaceId != null) {
    storage.taskUpdate(ticket.id, { status: 'in_progress' }, { type: 'system', name: 'OperonSpec' })
    started = await wakeTaskBinding(ticket.bindingId, message)
  } else if (ticket.assignedAgentId != null) {
    // It never started (or lost its worktree): start it afresh, the instructions waiting in its activity.
    try {
      await dispatchProjectTask(ticket.id, ticket.assignedAgentId)
      started = true
    } catch (err) {
      patchTicket(storage, spec.id, ticket.id, { state: 'blocked', blockedReason: `Could not start: ${err instanceof Error ? err.message : String(err)}`, coordinator: 'asked' })
      broadcastTask(storage, spec.id)
      throw new SpecError(`Ticket #${ticket.number} could not be started: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!started) {
    patchTicket(storage, spec.id, ticket.id, { state: 'blocked', blockedReason: 'Its implementer session could not be woken', coordinator: 'asked' })
    broadcastTask(storage, spec.id)
    throw new SpecError(`Ticket #${ticket.number}'s implementer could not be woken. Hand it to the user with spec_escalate.`)
  }
  broadcastTask(storage, ticket.id)
  broadcastTask(storage, spec.id)
  return `Ticket #${ticket.number} is building again (retry ${retries + 1} of ${MAX_COORDINATOR_RETRIES}).`
}

/** spec_add_ticket: a ticket the build is missing, built and reviewed like the rest. */
export async function addCoordinatorTicket(
  storage: BuildStorage,
  spec: Task,
  input: { title: string; delivers: string; acceptance: string[]; blockedBy?: number[] },
): Promise<string> {
  const run = storage.specRunGet(spec.id)
  if (run?.stage !== 'building') throw new SpecError(`Spec #${spec.number} is ${run?.stage ?? 'not a spec'}; tickets are added while it is building`)
  const title = input.title.trim()
  const acceptance = input.acceptance.map((a) => a.trim()).filter(Boolean)
  if (!title || !input.delivers.trim() || acceptance.length === 0) {
    throw new SpecError('A ticket needs a title, what it delivers, and at least one acceptance criterion')
  }
  const blockedBy = (input.blockedBy ?? []).map((n) => entryFor(storage, spec, n).entry.key)
  const n = run.build.filter((b) => b.key.startsWith('K')).length + 1
  const ticket: SpecTicket = { key: `K${n}`, title, delivers: input.delivers.trim(), acceptance, blockedBy, interfaces: [] }
  const child = await addTicket(storage, spec, ticket)
  storage.taskAppendActivity(spec.id, {
    kind: 'system',
    actorType: 'agent',
    actorName: 'Spec coordinator',
    body: `Added ticket #${child.number} (${ticket.key}): ${title}`,
  })
  await advance(storage, spec.id)
  return `Added ticket #${child.number} (${ticket.key}); it starts once ${blockedBy.length > 0 ? `${blockedBy.join(', ')} merged and ` : ''}a slot is free.`
}

/**
 * spec_escalate: hand something to the user, with what the coordinator found.
 * Naming the ticket it is about settles that ticket: its turn ending must not
 * tell the user twice.
 */
export function escalate(storage: BuildStorage, spec: Task, message: string, actorName: string, ticketNumber?: number): string {
  const body = message.trim()
  if (!body) throw new SpecError('Say what the user needs to decide')
  if (ticketNumber != null) {
    const { entry, ticket } = entryFor(storage, spec, ticketNumber)
    if (entry.state === 'blocked') patchTicket(storage, spec.id, ticket.id, { coordinator: 'escalated' })
  }
  storage.taskAppendActivity(spec.id, { kind: 'comment', actorType: 'agent', actorId: null, actorName, body })
  notifySpec(storage, spec, 'spec_blocked', body.length > 280 ? `${body.slice(0, 277)}…` : body)
  broadcastTask(storage, spec.id)
  return `Told the user. Their answer comes back here as a comment on spec #${spec.number}.`
}

/**
 * spec_integration_done: the sign-off conflict is resolved and committed. A
 * reviewer from another family checks the resolution, then gate 2 is back.
 */
export async function integrationDone(storage: BuildStorage, spec: Task, summary: string): Promise<string> {
  const run = storage.specRunGet(spec.id)
  if (run?.stage !== 'integrating') throw new SpecError(`Spec #${spec.number} is ${run?.stage ?? 'not a spec'}, not resolving a sign-off conflict`)
  const loc = locationOf(storage, spec)
  const integration = await readSpecJson<SpecIntegration>(loc, SPEC_FILES.integration)
  if (!integration) throw new SpecError(`Spec #${spec.number} has no sign-off conflict on record`)
  if (await isMerging(loc.worktreePath)) throw new SpecError('The merge is not finished: resolve the conflicts and commit it first')
  const status = await getStatus(loc.worktreePath)
  if (status.files.length > 0) {
    throw new SpecError(`The worktree has uncommitted changes (${status.files.slice(0, 5).map((f) => f.path).join(', ')}): commit or discard them first`)
  }
  if (!(await isAncestor(loc.worktreePath, integration.target))) {
    throw new SpecError(`\`${integration.target}\` is not merged in yet (or moved on since): run git merge ${integration.target}, resolve, commit`)
  }
  await writeSpecFiles(loc, { [SPEC_FILES.integration]: JSON.stringify({ ...integration, summary: summary.trim() || '(no summary)' }, null, 2) }, 'sign-off conflict resolved')
  storage.taskAppendActivity(spec.id, {
    kind: 'system',
    actorType: 'agent',
    actorName: 'Spec coordinator',
    body: `Resolved the conflict merging \`${integration.target}\`. A reviewer checks the resolution before sign-off.`,
  })
  onAllTicketsMerged(storage, spec.id)
  return `Handed in. A reviewer from another model family checks the resolution; then spec #${spec.number} is back at sign-off. End your turn.`
}
