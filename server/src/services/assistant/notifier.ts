import type { AssistantApproval, AssistantMessage } from '../../../../shared/assistant.js'
import type { NotificationStorageAdapter } from '../../storage/interface.js'
import { emitInboxEvent } from '../channel-bus.js'
import { emitCounts, notify } from '../notification-service.js'

/** One inbox row for everything the assistant says on its own, like one row per chat. */
export const ASSISTANT_MESSAGE_SOURCE = 'assistant:message'
/** Each permission card is its own row, so answering one retires exactly that row. */
export const assistantApprovalSource = (approvalId: string): string => `assistant:approval:${approvalId}`

/** A turn with no end-of-turn signal still goes out after this long. */
const FLUSH_FALLBACK_MS = 5_000
const BODY_MAX = 180

export interface AssistantNotifierDeps {
  storage: () => NotificationStorageAdapter | null
  /** The assistant's name as the user set it (identity.md); the row's title. */
  name: () => string
  /** Inside the user's quiet hours right now. */
  quiet: () => boolean
  /** The assistant's thread is on someone's screen. */
  viewed: () => boolean
}

/**
 * Puts the assistant into the inbox — and through it onto the user's phone — for the two
 * things that happen while they are not looking: it speaks up on its own, or one of its
 * workers stops on a permission card.
 *
 * Replies to the user's own message are left out, same as a chat they started: they asked
 * and are presumably waiting. A turn's messages are collected and sent once at the end of
 * the turn, so a reply in several parts buzzes once with the whole thing.
 *
 * Quiet hours keep the row but not the buzz, with one exception: a heartbeat finding. The
 * heartbeat is already held to urgent-only in quiet hours, so whatever it still says is
 * the thing quiet hours were meant to let through.
 */
export class AssistantNotifier {
  private pending: AssistantMessage[] = []
  private seen = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly deps: AssistantNotifierDeps) {}

  /** Every message the thread shows passes through here; only new, unprompted ones are kept. */
  message(message: AssistantMessage): void {
    if (message.role !== 'assistant' || !message.trigger || message.approval) return
    if (!message.text.trim() || this.seen.has(message.id)) return
    this.seen.add(message.id)
    if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-200))
    this.pending.push(message)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), FLUSH_FALLBACK_MS)
    this.timer.unref?.()
  }

  /** The main agent finished its turn. */
  turnEnded(): void {
    this.flush()
  }

  /** A permission card was put up (no decision yet) or answered. */
  approval(approval: AssistantApproval): void {
    const storage = this.deps.storage()
    if (!storage) return
    const sourceKey = assistantApprovalSource(approval.id)
    if (approval.decision) {
      retire(storage, sourceKey)
      return
    }
    notify(storage, {
      kind: 'assistant_approval',
      severity: 'action',
      sourceKey,
      title: this.deps.name(),
      body: approval.title,
      push: !this.deps.quiet(),
    })
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const messages = this.pending.splice(0)
    if (!messages.length || this.deps.viewed()) return
    const storage = this.deps.storage()
    if (!storage) return
    const heartbeat = messages.some((m) => m.trigger?.kind === 'heartbeat')
    notify(storage, {
      kind: 'assistant_message',
      severity: 'info',
      sourceKey: ASSISTANT_MESSAGE_SOURCE,
      title: this.deps.name(),
      body: snippet(messages.map((m) => m.text).join(' ')),
      push: heartbeat || !this.deps.quiet(),
    })
  }
}

function retire(storage: NotificationStorageAdapter, sourceKey: string): void {
  try {
    const readIds = storage.notificationMarkReadBySource(sourceKey)
    for (const id of readIds) {
      const row = storage.notificationGet(id)
      if (row) emitInboxEvent({ type: 'notification_upsert', notification: row })
    }
    if (readIds.length) emitCounts(storage)
  } catch (err) {
    console.error('[assistant] retiring approval row failed:', err)
  }
}

/** Markdown down to one plain line that fits a banner. */
export function snippet(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > BODY_MAX ? `${plain.slice(0, BODY_MAX - 1).trimEnd()}…` : plain
}
