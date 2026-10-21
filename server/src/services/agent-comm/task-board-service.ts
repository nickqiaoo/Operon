import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
  NotificationStorageAdapter,
  ProjectStorageAdapter,
  TaskStorageAdapter,
} from '../../storage/interface.js'
import { broadcastTask } from '../task-events.js'
import { notifyTaskStatusChange } from '../notification-service.js'
import { mirrorAgentComment } from '../../gateway/surfaces/surface-sync.js'
import { submitPullRequest } from '../../gateway/surfaces/pull-request-tool.js'
import type { CreatedTaskRef } from '@shared/taskboard/tools'
import {
  maybeAutoDispatchTask,
  maybeAutoIntegrate,
} from '../channel/agent-orchestrator.js'
import {
  isValidTaskTransition,
  type Task,
  type TaskActivity,
  type TaskPriority,
  type TaskStatus,
} from '../../types/task.js'
import { getChatStorage } from '../ai/state.js'
import { getProviders } from '../ai/providers.js'
import { isReviewedTicket } from '../spec/build-run.js'
import { SpecError, answerSpecQuestions, startSpec } from '../spec/spec-service.js'
import { dismissSwitchProposal, proposeSwitch, switchSpecSeat } from '../spec/switch.js'
import { isSpecRole, type SpecSwitch } from '../../types/spec.js'
import { SPEC_FILES, specDir } from '../spec/files.js'
import {
  addCoordinatorTicket,
  escalate,
  integrationDone,
  isCoordinatorOf,
  retryTicket,
  specStatus,
  wakeCoordinator,
} from '../spec/coordinator.js'

/**
 * A tool result that carries a machine-readable payload beside the prose. The
 * prose goes to the model; `structured` goes into the MCP result's
 * `structuredContent`, so the UI never has to parse English to learn what
 * happened. Tools that have nothing structured to say just return a string.
 */
export interface ToolResult {
  text: string
  structured?: CreatedTaskRef
  /**
   * Marks a tool-level failure. Per the MCP spec these belong in the result with
   * `isError: true` — NOT as a protocol error — so the model can see what went
   * wrong and correct itself, while a client can still tell success from refusal.
   */
  isError?: boolean
}

/** A refusal or failure the model should read and act on. */
function toolError(text: string): ToolResult {
  return { text, isError: true }
}

export type TaskBoardStorage = TaskStorageAdapter &
  ChannelStorageAdapter &
  ProjectStorageAdapter &
  NotificationStorageAdapter &
  Pick<AgentBindingStorageAdapter, 'getBinding'>

/** A switch as the spec tools take it. */
export interface SwitchToolInput {
  role: string
  /** A ticket's task number. */
  ticket?: number
  /** A candidate's letter (A, B…). */
  candidate?: string
  provider: string
  model?: string
}

/** Who acts when the spec's chat does something on the user's word. */
const USER_IN_CHAT = { type: 'human' as const, id: null, name: 'You (in chat)' }

export class TaskBoardService {
  constructor(
    private readonly storage: TaskBoardStorage,
    private readonly projectId: number,
    /** Direct workspace chat this session is — where a spec it starts reports
     *  back. Derived from the session URL, never from a model argument. */
    private readonly sourceChatId?: number,
  ) {}

  private requireTask(number: number): Task {
    const task = this.storage.taskGetByNumber(this.projectId, number)
    if (!task) throw new Error(`Task #${number} not found in this project.`)
    return task
  }

  private agentName(agentId: number | null): string | null {
    return agentId != null ? this.storage.getAgent(agentId)?.name ?? null : null
  }

  private formatRow(t: Task): string {
    const assignee = t.assignedAgentId ? ` -> @${this.agentName(t.assignedAgentId) ?? t.assignedAgentId}` : ''
    const labels = this.storage.taskGetLabels(t.id).map((l) => l.name)
    const labelStr = labels.length ? ` [${labels.join(', ')}]` : ''
    return `#${t.number} [${t.status}] ${t.title}${assignee}${labelStr}`
  }

  list(filter: {
    status?: TaskStatus
    assignedAgentId?: number
    labelId?: number
    priority?: TaskPriority
  }): string {
    const tasks = this.storage.taskList({ projectId: this.projectId, ...filter })
    if (tasks.length === 0) return 'No tasks match.'
    return `## Tasks (${tasks.length})\n` + tasks.map((t) => this.formatRow(t)).join('\n')
  }

  async get(number: number): Promise<string> {
    const detail = this.storage.taskDetail(this.requireTask(number).id)
    if (!detail) throw new Error(`Task #${number} not found.`)
    const assignee = detail.assignedAgentId ? `@${this.agentName(detail.assignedAgentId)}` : 'unassigned'
    const labels = detail.labels.map((l) => l.name).join(', ') || '(none)'
    const lines = [
      `# Task #${detail.number}: ${detail.title}`,
      `status=${detail.status} priority=${detail.priority} assignee=${assignee} labels=${labels}`,
    ]
    if (detail.branchName) lines.push(`branch=${detail.branchName}`)
    lines.push('', '## Description', detail.description || '(none)')
    // A spec: where it stands and where its files are. The files themselves are
    // on the change branch; a ticket's worktree was cut from it.
    const run = this.storage.specRunGet(detail.id)
    if (run) {
      lines.push(
        '',
        '## Spec',
        `stage=${run.stage}; files in \`${specDir(detail.number)}/\` on \`${detail.branchName ?? '?'}\` ` +
          `(${SPEC_FILES.brief}, ${SPEC_FILES.design}, ${SPEC_FILES.tickets}, ${SPEC_FILES.review})`,
      )
    } else if (detail.parentTaskId != null && this.storage.specRunGet(detail.parentTaskId)) {
      const parent = this.storage.taskGet(detail.parentTaskId)
      if (parent) {
        lines.push('', '## Spec', `ticket of spec #${parent.number}; design in \`${specDir(parent.number)}/${SPEC_FILES.design}\``)
      }
    }
    lines.push('', '## Activity')
    if (detail.activity.length === 0) {
      lines.push('(none)')
    } else {
      for (const activity of detail.activity) {
        lines.push(activity.kind === 'comment'
          ? `- ${activity.actorName}: ${activity.body}`
          : `- ${activity.actorName} ${describeActivity(activity)}`)
      }
    }
    return lines.join('\n')
  }

  dispatchTask(number: number, assignee: string, actorAgentId: number): string | ToolResult {
    const task = this.requireTask(number)
    const assigneeName = assignee.trim().replace(/^@/, '')
    if (!assigneeName) return toolError('Assignee is required.')
    const assigneeAgent = this.storage.getAgentByName(assigneeName)
    if (!assigneeAgent) return toolError(`Agent @${assigneeName} not found.`)
    const assigneeAgentId = assigneeAgent.id
    if (task.assignedAgentId != null && task.assignedAgentId !== assigneeAgentId) {
      return toolError(
        `Task #${number} is already assigned to @${this.agentName(task.assignedAgentId)}. Move on.`,
      )
    }
    const advance = task.status === 'todo'
    this.storage.taskUpdate(
      task.id,
      {
        assignedAgentId: assigneeAgentId,
        ...(advance ? { status: 'in_progress' as TaskStatus } : {}),
      },
      { type: 'agent', id: actorAgentId, name: this.agentName(actorAgentId) ?? 'agent' },
    )
    broadcastTask(this.storage, task.id)
    // Moving into in_progress should actually start the assigned agent in its worktree.
    if (advance) {
      void maybeAutoDispatchTask(task.id).catch((err) =>
        console.error('[TaskBoard] auto-dispatch after dispatch failed:', err),
      )
    }
    return `Dispatched task #${number} to @${assigneeAgent.name}${advance ? ' -> in_progress' : ''}.`
  }

  async update(
    number: number,
    updates: { status?: TaskStatus; priority?: TaskPriority; title?: string; description?: string },
    agentId: number,
  ): Promise<string | ToolResult> {
    const task = this.requireTask(number)
    if (updates.status != null) {
      if (task.assignedAgentId !== agentId) {
        return toolError(
          `Only the assignee can change task #${number}'s status; dispatch it to this agent first.`,
        )
      }
      if (!isValidTaskTransition(task.status, updates.status)) {
        return toolError(`Invalid transition for #${number}: ${task.status} -> ${updates.status}.`)
      }
      if (updates.status === 'done') {
        return toolError(
          `Human review required for #${number}: set it to in_review when ready; a human marks Done after review.`,
        )
      }
    }
    this.storage.taskUpdate(task.id, updates, {
      type: 'agent',
      id: agentId,
      name: this.agentName(agentId) ?? 'agent',
    })
    broadcastTask(this.storage, task.id)
    // Inbox: agent moved the task (e.g. → in_review "ready for your review").
    // A spec ticket in review waits on its reviewer agent, not on the user.
    if (updates.status != null && !(updates.status === 'in_review' && isReviewedTicket(this.storage, task.id))) {
      notifyTaskStatusChange(this.storage, task, updates.status, task.status)
    }
    if (updates.status === 'in_progress') {
      void maybeAutoDispatchTask(task.id).catch((err) =>
        console.error('[TaskBoard] auto-dispatch after update failed:', err),
      )
    } else if (updates.status === 'in_review') {
      void maybeAutoIntegrate(task.id, updates.status, {
        type: 'agent',
        id: agentId,
        name: this.agentName(agentId) ?? 'agent',
      }).catch((err) => console.error('[TaskBoard] auto-integrate after update failed:', err))
    }
    return `Updated task #${number}.`
  }

  /**
   * OperonSpec entry. Only a direct workspace chat can start one: the spec's
   * design results are delivered back into that conversation, and its provider
   * is who leads the design.
   */
  async startSpec(
    input: { title: string; brief: string; candidates?: string[] },
    agentId: number,
  ): Promise<ToolResult> {
    if (this.sourceChatId == null) {
      return toolError('OperonSpec can only be started from a workspace chat — this session has no conversation to report back to.')
    }
    const meta = getChatStorage()?.getChatMeta(this.sourceChatId)
    if (!meta?.providerId) return toolError('Could not start the spec: this chat has no provider recorded yet.')
    const agent = this.storage.getAgent(agentId)
    try {
      const { task, reused } = await startSpec(this.storage, {
        projectId: this.projectId,
        chatId: this.sourceChatId,
        actor: { type: 'agent', id: agentId, name: agent?.name ?? 'Assistant' },
        title: input.title,
        brief: input.brief,
        lead: { providerId: meta.providerId, ...(meta.model ? { modelId: meta.model } : {}) },
        available: getProviders()
          .filter((p) => p.available)
          .map((p) => p.id),
        candidates: input.candidates,
      })
      const ref: CreatedTaskRef = {
        kind: 'created-task',
        taskId: task.id,
        taskNumber: task.number,
        title: task.title,
        spec: true,
      }
      if (reused) {
        return {
          text:
            `This chat already has an open spec: task #${task.number} (${task.specStage ?? 'unknown stage'}). ` +
            'Do not start another — continue that one (its result will come back to this chat).',
          structured: ref,
        }
      }
      const run = this.storage.specRunGet(task.id)
      const seats = run
        ? ` Candidates: ${run.config.candidates.map((c) => c.providerId).join(', ')}; judge: ${run.config.judge.providerId}.`
        : ''
      return {
        text:
          `Started spec task #${task.number} (branch ${task.branchName ?? '?'}).${seats} ` +
          'The design runs in the background and its result will be delivered to this chat — do not poll or wait. ' +
          'Tell the user it has started, that they can watch it in the Workflow tab, and stop here.',
        structured: ref,
      }
    } catch (e) {
      return toolError(`Could not start the spec: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Hand the user's answers to a spec waiting on them; the design run continues. */
  async answerSpecQuestions(taskNumber: number, answers: string): Promise<string | ToolResult> {
    try {
      const task = this.requireTask(taskNumber)
      await answerSpecQuestions(this.storage, task.id, answers)
      return `Answers saved on spec #${task.number}; the design continues in the background and its result will come back to this chat.`
    } catch (e) {
      if (e instanceof SpecError || e instanceof Error) return toolError(e.message)
      throw e
    }
  }

  // ---- OperonSpec coordinator ----

  /** The spec behind a task number, when `agentId` is its coordinator; otherwise a refusal to hand back. */
  private coordinatedSpec(number: number, agentId: number): Task | ToolResult {
    const spec = this.requireTask(number)
    if (!this.storage.specRunGet(spec.id)) return toolError(`#${number} is not a spec.`)
    if (!isCoordinatorOf(this.storage, spec, agentId)) {
      return toolError(`Only spec #${number}'s coordinator can do this. Comment on the spec instead.`)
    }
    return spec
  }

  private async asCoordinator(number: number, agentId: number, fn: (spec: Task) => Promise<string> | string): Promise<string | ToolResult> {
    const spec = this.coordinatedSpec(number, agentId)
    if ('text' in spec) return spec
    try {
      return await fn(spec)
    } catch (e) {
      if (e instanceof SpecError || e instanceof Error) return toolError(e.message)
      throw e
    }
  }

  /** Readable by anyone: where a spec and its tickets stand. */
  async specStatus(number: number): Promise<string | ToolResult> {
    try {
      return await specStatus(this.storage, this.requireTask(number))
    } catch (e) {
      if (e instanceof Error) return toolError(e.message)
      throw e
    }
  }

  specRetryTicket(number: number, input: { ticket: number; instructions: string; ruling?: string }, agentId: number) {
    return this.asCoordinator(number, agentId, (spec) => retryTicket(this.storage, spec, input, this.agentName(agentId) ?? 'Spec coordinator'))
  }

  specAddTicket(
    number: number,
    input: { title: string; delivers: string; acceptance: string[]; blockedBy?: number[] },
    agentId: number,
  ) {
    return this.asCoordinator(number, agentId, (spec) => addCoordinatorTicket(this.storage, spec, input))
  }

  specEscalate(number: number, message: string, agentId: number, ticket?: number) {
    return this.asCoordinator(number, agentId, (spec) =>
      escalate(this.storage, spec, message, this.agentName(agentId) ?? 'Spec coordinator', ticket),
    )
  }

  specIntegrationDone(number: number, summary: string, agentId: number) {
    return this.asCoordinator(number, agentId, (spec) => integrationDone(this.storage, spec, summary))
  }

  specProposeSwitch(number: number, input: SwitchToolInput, reason: string, agentId: number) {
    return this.asCoordinator(number, agentId, (spec) =>
      proposeSwitch(this.storage, spec, this.toSwitch(spec, input), reason, this.agentName(agentId) ?? 'Spec coordinator'),
    )
  }

  // ---- OperonSpec, from the chat it was started from ----

  /**
   * Run `fn` for the spec behind a task number when this session is the chat
   * that spec was started from — where the user talks to it, so what is asked
   * here is the user's say-so. Anyone else gets a refusal.
   */
  private async asSpecChat(number: number, fn: (spec: Task) => Promise<string> | string): Promise<string | ToolResult> {
    try {
      const spec = this.requireTask(number)
      if (!this.storage.specRunGet(spec.id)) return toolError(`#${number} is not a spec.`)
      if (this.sourceChatId == null || spec.sourceChatId !== this.sourceChatId) {
        return toolError(`Only the chat spec #${number} was started from can do this: it is where the user decides.`)
      }
      return await fn(spec)
    } catch (e) {
      if (e instanceof SpecError || e instanceof Error) return toolError(e.message)
      throw e
    }
  }

  specSwitchAgent(number: number, input: SwitchToolInput) {
    return this.asSpecChat(number, (spec) => switchSpecSeat(this.storage, spec.id, this.toSwitch(spec, input), USER_IN_CHAT))
  }

  specDeclineSwitch(number: number, note?: string) {
    return this.asSpecChat(number, async (spec) => {
      await dismissSwitchProposal(this.storage, spec.id, USER_IN_CHAT, note)
      return `Turned the switch down; the coordinator of #${number} has been told.`
    })
  }

  specMessageCoordinator(number: number, message: string) {
    return this.asSpecChat(number, async (spec) => {
      const body = message.trim()
      if (!body) throw new SpecError('The message is empty')
      this.storage.taskAppendActivity(spec.id, { kind: 'comment', actorType: 'human', actorName: USER_IN_CHAT.name, body })
      broadcastTask(this.storage, spec.id)
      const woke = await wakeCoordinator(
        this.storage,
        spec,
        `[The user, from the chat spec #${number} was started from]: ${body}\n` +
          `Act on it; if you need them again, use spec_propose_switch or spec_escalate — that reaches them in that chat.`,
      )
      if (!woke) throw new SpecError(`The coordinator of #${number} could not be woken`)
      return `Passed to the coordinator of #${number}; it works on it in the background and comes back here if it needs the user.`
    })
  }

  /** A switch as the tools name it (ticket by number, candidate by letter), as the spec names it. */
  private toSwitch(spec: Task, input: SwitchToolInput): SpecSwitch {
    if (!isSpecRole(input.role)) throw new SpecError(`"${input.role}" is not a spec role`)
    let ticketKey: string | undefined
    if (input.ticket != null) {
      const ticket = this.storage.taskGetByNumber(this.projectId, input.ticket)
      ticketKey = ticket ? this.storage.specRunGet(spec.id)?.build.find((b) => b.taskId === ticket.id)?.key : undefined
      if (!ticketKey) throw new SpecError(`#${input.ticket} is not a ticket of spec #${spec.number}`)
    }
    const letter = input.candidate?.trim().toUpperCase()
    const index = letter ? (/^\d+$/.test(letter) ? Number(letter) - 1 : letter.charCodeAt(0) - 65) : undefined
    return {
      role: input.role,
      ...(index != null ? { index } : {}),
      ...(ticketKey ? { ticketKey } : {}),
      to: { providerId: input.provider.trim(), ...(input.model?.trim() ? { modelId: input.model.trim() } : {}) },
    }
  }

  comment(number: number, body: string, agentId: number): string {
    const task = this.requireTask(number)
    const agentName = this.agentName(agentId) ?? 'agent'
    this.storage.taskAppendActivity(task.id, {
      kind: 'comment',
      actorType: 'agent',
      actorId: agentId,
      actorName: agentName,
      body,
    })
    broadcastTask(this.storage, task.id)
    // Progress notes are visible on the Linear issue too (design.md §9).
    mirrorAgentComment(task.id, agentName, body)
    return `Posted to task #${number}.`
  }

  /**
   * Push the task branch and open (or update) its pull request. Only the
   * task's own execution agent may ship it; the worktree carries no
   * credentials, so this is the one way code leaves the machine.
   */
  async submitPullRequest(
    number: number,
    input: { title: string; body: string; branch: string },
    agentId: number,
  ): Promise<ToolResult> {
    const task = this.requireTask(number)
    if (task.assignedAgentId !== agentId) {
      return toolError(`Only the agent assigned to task #${number} can submit its pull request.`)
    }
    const res = await submitPullRequest(this.storage, task, input)
    return res.isError ? toolError(res.text) : { text: res.text }
  }
}

function describeActivity(activity: TaskActivity): string {
  const meta = activity.meta ?? {}
  switch (activity.kind) {
    case 'status':
      return `changed status ${String(meta.from ?? '')} -> ${String(meta.to ?? '')}`
    case 'assign':
      return meta.to ? 'assigned the task' : 'unassigned the task'
    case 'dispatch':
      return 'dispatched the task'
    case 'branch':
      return `created branch ${String(meta.branch ?? '')}`
    default:
      return activity.body || 'updated the task'
  }
}
