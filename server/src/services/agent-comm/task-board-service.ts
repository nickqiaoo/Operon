import type {
  ChannelStorageAdapter,
  NotificationStorageAdapter,
  ProjectStorageAdapter,
  TaskStorageAdapter,
} from '../../storage/interface.js'
import { broadcastTask } from '../task-events.js'
import { notifyTaskStatusChange } from '../notification-service.js'
import { SDD_WORKFLOW_PROMPT } from '../sdd/sdd-prompt.js'
import type { CreatedTaskRef } from '@shared/taskboard/tools'
import {
  maybeAutoDispatchTask,
  maybeAutoIntegrate,
} from '../channel/agent-orchestrator.js'
import {
  assertGateOrThrow,
  GateError,
  promoteToTask,
  type PromoteSource,
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

type TaskBoardStorage = TaskStorageAdapter &
  ChannelStorageAdapter &
  ProjectStorageAdapter &
  NotificationStorageAdapter

export class TaskBoardService {
  constructor(
    private readonly storage: TaskBoardStorage,
    private readonly projectId: number,
    /** Channel this session is bound to — the SDD promote source for a channel
     *  agent. Derived from the session URL, not a model argument. Undefined for
     *  non-channel sessions. */
    private readonly channelId?: number,
    /** Direct workspace chat this session is — the SDD promote source for a plain
     *  chat (mutually exclusive with channelId). Derived from the session URL. */
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
    if (updates.status != null) {
      // Inbox: agent moved the task (e.g. → in_review "ready for your review").
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
  async createSpecTask(
    input: { messageId?: number | null; title: string; description?: string },
    agentId: number,
  ): Promise<ToolResult> {
    // The promote source comes from the session (constructor), not the model:
    // a channel discussion, or a direct workspace chat. A session with neither
    // (task execution, IM bridge) has no discussion to convert.
    const source: PromoteSource | null =
      this.channelId != null
        ? { kind: 'channel', channelId: this.channelId, messageId: input.messageId ?? null }
        : this.sourceChatId != null
          ? { kind: 'chat', projectId: this.projectId, chatId: this.sourceChatId }
          : null
    if (source == null) {
      return toolError(
        'Could not create spec task: this session is not bound to a channel or a workspace chat, so there is no discussion to convert.',
      )
    }
    try {
      const task = await promoteToTask(this.storage, {
        source,
        authorAgentId: agentId,
        title: input.title,
        description: input.description,
      })
      broadcastTask(this.storage, task.id)
      // promoteToTask dedups a racing second promote: if the returned change was
      // authored by a DIFFERENT agent, this discussion is already being specced —
      // don't hand this caller the "you are the author" workflow, point it there.
      const ref: CreatedTaskRef = {
        kind: 'created-task',
        taskId: task.id,
        taskNumber: task.number,
        title: task.title,
        sddManaged: true,
      }
      if (task.specAuthorAgentId !== agentId) {
        return {
          text:
            `This discussion is already a spec-driven change: task #${task.number} (being authored by another agent). ` +
            `Don't start a duplicate — read it with get_project_task(task: ${task.number}) and coordinate there.`,
          structured: ref,
        }
      }
      // Deliver the full spec-driven workflow here (not pre-armed at session start):
      // promoting is what turns this discussion into a spec-driven change, so the
      // author agent learns the rules the moment it promotes.
      return {
        text:
          `Promoted to task #${task.number} (branch ${task.branchName ?? '?'}). You are now the spec author for this change. ` +
          `Follow this spec-driven workflow from here on:\n\n${SDD_WORKFLOW_PROMPT}\n\n` +
          `Start now: write the spec with write_artifact(task: ${task.number}, kind: "spec", content: "..."), ` +
          `then the plan — and stop there (acceptance is the verifier's report later, not yours). ` +
          `A human signs the design off by pressing Dispatch ` +
          `(Gate-0), which also splits the plan into subtasks and starts them. You never approve or decompose anything yourself.`,
        structured: ref,
      }
    } catch (e) {
      return toolError(`Could not promote: ${e instanceof Error ? e.message : String(e)}`)
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
    this.storage.taskAppendActivity(task.id, {
      kind: 'comment',
      actorType: 'agent',
      actorId: agentId,
      actorName: this.agentName(agentId) ?? 'agent',
      body,
    })
    broadcastTask(this.storage, task.id)
    return `Posted to task #${number}.`
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
