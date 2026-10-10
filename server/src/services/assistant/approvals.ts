import type { ApprovalDecision, AssistantApproval, AuditRecord } from '../../../../shared/assistant.js'

/** What answering looks like from the waiting worker's side. */
export type ApprovalAnswer = ApprovalDecision

/** What the approval center needs from the runtime: the thread, the audit log, the activity list. */
export interface ApprovalHost {
  /** Put a card in the thread (a new message), or replace it once answered. */
  card(messageId: string, approval: AssistantApproval, createdAt: number): void
  audit(record: AuditRecord): void
  /** The worker is (or is no longer) blocked on the user. */
  setWaiting(activityId: string, waiting: boolean): void
}

interface Pending {
  approval: AssistantApproval
  messageId: string
  createdAt: number
  resolve: (answer: ApprovalAnswer) => void
}

/**
 * Permission prompts from the assistant's workers, shown as cards in the thread. Two sources
 * feed it — the framework's `auto` judge escalating a tool call, and node_repl asking about a
 * new site or an app — and both wait here until the user answers. There is deliberately no
 * timeout: expiring on the user's behalf would read as a refusal they never made. A worker that
 * stops (or the app restarting) is what releases an unanswered card.
 */
export class AssistantApprovals {
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly host: ApprovalHost,
    private readonly newId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  request(input: Omit<AssistantApproval, 'id' | 'decision'>): Promise<ApprovalAnswer> {
    const approval: AssistantApproval = { ...input, id: this.newId() }
    const messageId = this.newId()
    const createdAt = this.now()
    return new Promise<ApprovalAnswer>((resolve) => {
      this.pending.set(approval.id, { approval, messageId, createdAt, resolve })
      this.host.card(messageId, approval, createdAt)
      if (approval.activityId) this.host.setWaiting(approval.activityId, true)
    })
  }

  /** The user's answer from the card. False when the card is unknown or already settled. */
  answer(id: string, decision: Exclude<ApprovalDecision, 'expired'>): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.settle(entry, decision)
    this.host.audit({
      id: this.newId(),
      title: entry.approval.title,
      detail: entry.approval.detail,
      icon: entry.approval.icon,
      decision,
      at: this.now(),
      ...(entry.approval.args ? { args: entry.approval.args } : {}),
      ...(entry.approval.activityId ? { activityId: entry.approval.activityId } : {}),
    })
    return true
  }

  /** Release every card a worker left unanswered (it stopped, failed or finished). */
  expireFor(activityId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.approval.activityId === activityId) this.settle(entry, 'expired')
    }
  }

  private settle(entry: Pending, decision: ApprovalAnswer): void {
    this.pending.delete(entry.approval.id)
    const approval = { ...entry.approval, decision }
    this.host.card(entry.messageId, approval, entry.createdAt)
    const activityId = approval.activityId
    if (activityId && decision !== 'expired' && ![...this.pending.values()].some((p) => p.approval.activityId === activityId)) {
      this.host.setWaiting(activityId, false)
    }
    entry.resolve(decision)
  }
}
