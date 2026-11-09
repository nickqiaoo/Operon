import type { Activity, ActivityCoding } from '../../../../shared/assistant.js'
import { CODING_ACTIVITY_TASK_PREFIX, WAITING_SUMMARY_PREFIX, WORKING_SUMMARY } from '../../../../shared/assistant.js'
import type { PendingInputSummary } from '../../../../shared/pending-input.js'
import type { Project, Workspace } from '../../types/project.js'
import type { Cause } from './projector.js'
import { describePending } from './operon-state.js'

/**
 * Coding agents the assistant starts in the user's workspaces (docs/assistant/operon-manager.md
 * §5). Each is an ordinary conversation tab in that workspace — an external agent whose parent is
 * the assistant — plus one Activity here that mirrors its state: running, waiting for the user,
 * done. The conversation is where the work is; the Activity is what the thread's card shows.
 */

/** What the coding agents need from the app, separate so tests can stand in for it. */
export interface CodingDelivery { delivery: string; warning?: string }

export interface CodingHost {
  workspace(id: number): { workspace: Workspace; project?: Project } | undefined
  /** Open the conversation and send the first prompt. */
  create(input: { activityId: string; workspaceId: number; providerId: string; model: string; effort?: string; title: string; prompt: string }): Promise<{ chatId: number }>
  /** The activity of a conversation the assistant started; undefined for any other. */
  activityOf(chatId: number): string | undefined
  send(chatId: number, prompt: string, delivery?: 'auto' | 'steer' | 'followup'): Promise<CodingDelivery | void>
  stop(chatId: number): boolean
  /** The conversation's state and latest result, as the external agent tools report it. */
  status(chatId: number): unknown
  diffStat(path: string): Promise<Record<string, { additions: number; deletions: number }>>
  activity(id: string): Activity | undefined
  save(activity: Activity): void
  /** Put the card for a newly started conversation in the thread. */
  card(activityId: string): void
  tell(text: string, cause: Cause): void
  now(): number
}

/** A turn that finished in a conversation the assistant started. */
export interface CodingTurnEnd {
  chatId: number
  status: 'completed' | 'cancelled' | 'failed'
  error?: string
  /** The prompt came from the assistant, not from the user typing in the conversation. */
  dispatched: boolean
  /** All text from this execution stream, including accepted followups. */
  result: string
  /** Its last text part: where an agent concludes, after narrating its work in the earlier ones. */
  final?: string
}

const RESULT_LIMIT = 6_000
const SUMMARY_LIMIT = 200

export class CodingAgents {
  /** Conversations whose current turn the main agent stopped itself. */
  private readonly stoppedByMain = new Set<number>()

  constructor(
    private readonly host: CodingHost,
    private readonly newId: () => string,
  ) {}

  async start(input: { workspaceId: number; title: string; prompt: string; providerId: string; model: string; effort?: string }): Promise<Activity> {
    const where = this.host.workspace(input.workspaceId)
    if (!where) throw new Error(`There is no workspace ${input.workspaceId}. Call workspace_list for the ids.`)
    const id = this.newId()
    const { chatId } = await this.host.create({ activityId: id, ...input })
    const coding: ActivityCoding = {
      chatId,
      workspaceId: where.workspace.id,
      workspaceName: where.workspace.name,
      ...(where.project ? { projectName: where.project.name } : {}),
      ...(where.workspace.branchName ? { branch: where.workspace.branchName } : {}),
      providerId: input.providerId,
      model: input.model,
      ...(input.effort ? { effort: input.effort } : {}),
    }
    const activity: Activity = {
      id,
      taskId: `${CODING_ACTIVITY_TASK_PREFIX}${chatId}`,
      agent: 'coding',
      coding,
      title: input.title,
      summary: WORKING_SUMMARY,
      status: 'running',
      startedAt: this.host.now(),
      steps: [],
    }
    this.host.save(activity)
    this.host.card(id)
    return activity
  }

  /** The Activity of `chatId`, which must be a conversation the assistant started. */
  private owned(chatId: number): Activity {
    const id = this.host.activityOf(chatId)
    const activity = id ? this.host.activity(id) : undefined
    if (!activity?.coding) throw new Error(`Conversation ${chatId} is not one you started. You can only message, check or stop those.`)
    return activity
  }

  /**
   * More for the agent. From the assistant (`title` given or not) the card comes down to the end
   * of the thread, under what was just said about it; `title` renames it for a new piece of work.
   */
  async send(chatId: number, message: string, card?: { title?: string; delivery?: 'auto' | 'steer' | 'followup' }): Promise<CodingDelivery | void> {
    const activity = this.owned(chatId)
    const delivery = this.host.send(chatId, message, card?.delivery)
    this.running(card?.title ? { ...activity, title: card.title } : activity)
    let receipt: CodingDelivery | void
    try {
      receipt = await delivery
    } catch (error) {
      // Nothing started, so no turn end will ever clear the running state.
      this.host.save(activity)
      throw error
    }
    if (card) this.host.card(activity.id)
    return receipt
  }

  stop(chatId: number, options?: { byMain?: boolean }): boolean {
    this.owned(chatId)
    if (options?.byMain) this.stoppedByMain.add(chatId)
    const stopped = this.host.stop(chatId)
    if (!stopped) this.stoppedByMain.delete(chatId)
    return stopped
  }

  status(chatId: number): unknown {
    this.owned(chatId)
    return this.host.status(chatId)
  }

  /** The conversation the activity mirrors, if it is a coding agent's. */
  chatOf(activityId: string): number | undefined {
    return this.host.activity(activityId)?.coding?.chatId
  }

  /** A turn started in the conversation — sent by the assistant or typed by the user there. */
  turnStarted(chatId: number): void {
    const id = this.host.activityOf(chatId)
    const activity = id ? this.host.activity(id) : undefined
    if (activity?.coding && activity.status !== 'waiting') this.running(activity)
  }

  async turnEnded(end: CodingTurnEnd): Promise<void> {
    const stoppedByMain = this.stoppedByMain.delete(end.chatId)
    const id = this.host.activityOf(end.chatId)
    const before = id ? this.host.activity(id) : undefined
    if (!before?.coding) return
    const diffStat = await this.diffStat(before.coding.workspaceId)
    // Read again: the conversation may have moved on while the worktree was being read.
    const activity = this.host.activity(before.id) ?? before
    const status = end.status === 'completed' ? 'done' : end.status === 'failed' ? 'failed' : 'stopped'
    const result = end.result.trim()
    const coding: ActivityCoding = { ...activity.coding!, ...(diffStat ? { diffStat } : {}) }
    delete coding.waitingFor
    delete coding.pending
    this.host.save({
      ...activity,
      coding,
      status,
      summary: firstLine(end.final || result) || (end.status === 'failed' ? (end.error ?? 'Failed') : end.status === 'cancelled' ? 'Stopped' : 'Done'),
      ...(result ? { report: result } : {}),
      finishedAt: this.host.now(),
    })
    if (end.status === 'cancelled' && stoppedByMain) return
    if (end.status === 'cancelled' && end.dispatched) {
      // It may be waiting on this turn, or have promised the user a result.
      this.host.tell(
        `[Coding agent stopped] "${activity.title}" — ${where(coding)}, conversation chat_id ${coding.chatId}. ` +
          'It was stopped, not by you. Do not restart it unless the user asks. ' +
          'No reply is needed: end your turn without saying anything.',
        { kind: 'coding', activityId: activity.id },
      )
      return
    }
    // The conclusion comes last, so the head is what gives way.
    const clipped = result.length > RESULT_LIMIT ? `… (truncated)\n${result.slice(-RESULT_LIMIT)}` : result
    const lines = [
      `[Coding agent finished] "${activity.title}" — ${where(coding)} — ${end.status}.`,
      `Agent: ${coding.providerId}, conversation chat_id ${coding.chatId}.`,
      `Uncommitted changes in the workspace now: ${diffStat ? `${diffStat.files} files, +${diffStat.additions} −${diffStat.deletions}` : 'none'}.`,
      ...(end.status === 'failed' && end.error ? [`Error: ${end.error}`] : []),
      ...(clipped ? ['Its reply:', clipped] : []),
      // The main agent may build on this work later, so it hears about turns it did not send too.
      ...(end.dispatched ? [] : ['The user is talking to this agent directly; this is for your information. Do not act on it unless the user asks. No reply is needed: end your turn without saying anything.']),
    ]
    this.host.tell(lines.join('\n'), { kind: 'coding', activityId: activity.id })
  }

  /** The conversation is now blocked on the user (`pending` non-empty) or no longer is. */
  pendingChanged(chatId: number, pending: Array<PendingInputSummary & { toolInput?: unknown }>, first: boolean): void {
    const id = this.host.activityOf(chatId)
    const activity = id ? this.host.activity(id) : undefined
    if (!activity?.coding) return
    if (pending.length) {
      const waitingFor = pending.map(describePending).join('; ')
      const requests = pending.map((p) => ({
        approvalId: p.approvalId,
        toolName: p.toolName,
        ...(p.inputPreview ? { preview: p.inputPreview } : {}),
        ...(p.toolInput !== undefined ? { input: p.toolInput } : {}),
      }))
      this.host.save({
        ...activity,
        status: 'waiting',
        summary: `${WAITING_SUMMARY_PREFIX}${waitingFor}`,
        coding: { ...activity.coding, waitingFor, pending: requests },
      })
      if (!first) return
      this.host.tell(
        `[Coding agent waiting] "${activity.title}" — ${where(activity.coding)} — is asking the user: ${waitingFor}. ` +
          'Only the user can answer: right on its card in this thread, or in that conversation. Tell them in a sentence what it asks; do not answer for them.',
        { kind: 'coding', activityId: activity.id },
      )
      return
    }
    if (activity.status !== 'waiting') return
    const coding = { ...activity.coding }
    delete coding.waitingFor
    delete coding.pending
    this.host.save({ ...activity, status: 'running', summary: WORKING_SUMMARY, coding })
  }

  private running(activity: Activity): void {
    const coding = { ...activity.coding! }
    delete coding.waitingFor
    delete coding.pending
    const next: Activity = { ...activity, status: 'running', summary: WORKING_SUMMARY, coding }
    delete next.finishedAt
    this.host.save(next)
  }

  private async diffStat(workspaceId: number): Promise<ActivityCoding['diffStat'] | undefined> {
    const path = this.host.workspace(workspaceId)?.workspace.worktreePath
    if (!path) return undefined
    try {
      const files = Object.values(await this.host.diffStat(path))
      if (!files.length) return undefined
      return {
        files: files.length,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
      }
    } catch {
      return undefined
    }
  }
}

function where(coding: ActivityCoding): string {
  return `${coding.projectName ? `project "${coding.projectName}", ` : ''}workspace "${coding.workspaceName}"`
}

/** The first line, as plain text: the card shows it unrendered. */
function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/`|\*\*/g, '').trim())
      .find(Boolean) ?? ''
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT)}…` : line
}
