import type {
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
  assertGateOrThrow,
  GateError,
  writeArtifact as sddWriteArtifact,
  planAcWarnings,
  sedimentChange,
  readArtifactContent,
} from '../sdd/sdd-service.js'
import {
  isValidTaskTransition,
  type ArtifactKind,
  type Task,
  type TaskActivity,
  type TaskPriority,
  type TaskStatus,
} from '../../types/task.js'
import { getChatStorage } from '../ai/state.js'
import { getProviders } from '../ai/providers.js'
import { isReviewedTicket } from '../spec/build-run.js'
import { SpecError, answerSpecQuestions, startSpec } from '../spec/spec-service.js'

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
  NotificationStorageAdapter

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
    // SDD: surface spec/plan/acceptance (status + current content from the change branch).
    if (detail.sddManaged && detail.parentTaskId != null) {
      // Child task: it has no spec of its own — surface the PARENT's spec/plan/
      // acceptance plus the AC ids this subtask owns (§11.1 / §4).
      const parent = this.storage.taskGet(detail.parentTaskId)
      lines.push(
        '',
        '## SDD (subtask)',
        `parent=#${parent?.number ?? detail.parentTaskId} ` +
          `planAnchor=${detail.planAnchor ?? '(none)'} ` +
          `claimedAcs=${detail.claimedAcs?.join(', ') || '(none)'}`,
      )
      if (parent) {
        for (const kind of ['spec', 'plan', 'acceptance'] as ArtifactKind[]) {
          const content = await readArtifactContent(this.storage, parent, kind)
          if (content != null) lines.push('', `### parent ${kind}`, content)
        }
      }
    } else if (detail.sddManaged) {
      const artifacts = this.storage.taskArtifactList(detail.id)
      lines.push('', '## SDD Artifacts')
      if (artifacts.length === 0) {
        lines.push('(none yet — author writes spec via write_artifact)')
      }
      for (const a of artifacts) {
        const content = await readArtifactContent(this.storage, detail, a.kind)
        lines.push(`### ${a.kind} [${a.status}]`, content ?? '(no content)')
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
      try {
        assertGateOrThrow(this.storage, task, updates.status)
      } catch (e) {
        if (e instanceof GateError) return toolError(e.message)
        throw e
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

  /** Create an SDD parent task from a converged channel discussion (the caller becomes spec author). */
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
        sddManaged: false,
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

  /** Write an artifact (spec/plan/acceptance) for an SDD task; single-writer enforced in sdd-service. */
  async writeArtifact(
    number: number,
    kind: ArtifactKind,
    content: string,
    agentId: number,
  ): Promise<string | ToolResult> {
    const task = this.requireTask(number)
    // Soft-warn (the single-writer ownership lock was removed): writing spec/plan
    // when you aren't the recorded spec author is allowed, but surface it so the
    // agent can reconsider clobbering someone else's authored artifact.
    const overwritingOthersAuthorship =
      (kind === 'spec' || kind === 'plan') &&
      task.specAuthorAgentId != null &&
      task.specAuthorAgentId !== agentId
    try {
      const artifact = await sddWriteArtifact(this.storage, {
        taskId: task.id,
        kind,
        content,
        caller: { type: 'agent', id: agentId, name: this.agentName(agentId) ?? 'agent' },
      })
      broadcastTask(this.storage, task.id)
      let msg = `Wrote ${kind} for task #${number} (status: ${artifact.status}). Awaiting human approval.`
      if (overwritingOthersAuthorship) {
        const authorName =
          this.agentName(task.specAuthorAgentId as number) ?? `agent ${task.specAuthorAgentId}`
        msg +=
          ` Note: this ${kind} was originally authored by ${authorName}, not you — you have just overwritten it, ` +
          `and it is back to draft (needs re-approval). If that was not intended, coordinate via ` +
          `get_project_task(${number}) / comment_project_task before rewriting.`
      }
      // A plan is the one artifact we can cross-check for free: its rows claim the
      // AC ids the spec defines, so a mismatch is the author contradicting itself
      // and is worth saying now rather than at sign-off (§8).
      if (kind === 'plan') {
        const warnings = await planAcWarnings(this.storage, task, content)
        if (warnings.length > 0) {
          msg += ` AC coverage: ${warnings.join(' ')}`
        }
      }
      return msg
    } catch (e) {
      return toolError(`Could not write ${kind}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Sediment a change's spec_delta into the living spec (§13); preview unless apply (agent). */
  async sediment(number: number, apply: boolean, agentId: number): Promise<string | ToolResult> {
    const task = this.requireTask(number)
    try {
      const r = await sedimentChange(
        this.storage,
        task.id,
        { type: 'agent', id: agentId, name: this.agentName(agentId) ?? 'agent' },
        { apply },
      )
      if (r.conflicts.length > 0) {
        return (
          `Sediment blocked for ${r.capability}: semantic conflict(s) — resolve with a human:\n` +
          r.conflicts.map((c) => `- ${c.kind} ${c.id}: ${c.detail}`).join('\n')
        )
      }
      if (apply) {
        broadcastTask(this.storage, task.id)
        return `Sedimented ${r.capability} into the living spec (on the change branch).`
      }
      return `Preview — ${r.capability} would sediment cleanly. Living spec after:\n\n${r.preview}`
    } catch (e) {
      return toolError(`Could not sediment #${number}: ${e instanceof Error ? e.message : String(e)}`)
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
