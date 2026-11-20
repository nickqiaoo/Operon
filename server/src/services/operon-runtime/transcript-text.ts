import { PEER_SOURCE } from 'operon-agents-peers'

/**
 * How a user-role `message.appended` reads in the transcript. Shared by the passive
 * observer (which saves the ones that start a turn) and the stream mapper (which
 * places the ones that arrive mid-turn inside the reply).
 */

type AppendedEvent = { message?: unknown; origin?: unknown }

/**
 * The sender's name when this `message.appended` carries a peer delivery, as the RECIPIENT
 * knows it (`lead`, `dba`) — the framework resolves the roster id to that name before it
 * ever reaches the journal (see `PeerNetwork.deliver`).
 */
export function peerSender(event: { origin?: unknown }): string | undefined {
  const origin = event.origin as { kind?: unknown; source?: unknown; actor?: unknown } | undefined
  if (origin?.kind !== 'external' || origin.source !== PEER_SOURCE) return undefined
  return typeof origin.actor === 'string' ? origin.actor.trim() || undefined : undefined
}

/** Prompt origins that are plumbing, not conversation — never shown as a user turn. */
const HIDDEN_ORIGINS = new Set(['injection', 'compaction_summary', 'handoff_seed'])

/** Origins of something the person typed: a prompt, or a steer sent while a turn ran. */
const USER_ORIGINS = new Set(['user', 'user_follow_up'])

/**
 * The user-visible text of a `message.appended` event, or undefined when it is not a
 * user-role message worth a transcript row (assistant messages, skill/todo injections,
 * compaction summaries). A peer message arrives wrapped as
 * `<external-message source="peer" …>…</external-message>`; the wrapper is dropped so
 * the bubble reads as the message itself.
 */
export function transcriptUserText(event: AppendedEvent): string | undefined {
  const origin = event.origin as { kind?: unknown } | undefined
  if (typeof origin?.kind === 'string' && HIDDEN_ORIGINS.has(origin.kind)) return undefined
  const text = userMessageText(event.message)
  if (!text) return undefined
  if (/^<system-reminder>/i.test(text)) return undefined
  const unwrapped = text
    .replace(/^<external-message\b[^>]*>\s*/i, '')
    .replace(/\s*<\/external-message>\s*$/i, '')
    // The framework's "not from the user" preamble is for the model, not the reader.
    .replace(/^\[system: automated event[^\]]*\]\s*/i, '')
    .trim()
  return unwrapped || undefined
}

/**
 * The text of an automated event that reached the agent — a background task settling,
 * a monitor's output, an extension speaking — or undefined for anything else. Nobody
 * typed these: they are user-role only because that is how text reaches the model.
 * Arriving mid-turn, one belongs inside the reply at the point the agent read it, not
 * ahead of the reply as if it had started the turn. A teammate's message is not one:
 * it is a side of a conversation and keeps its own row.
 */
export function automatedNoticeText(event: AppendedEvent): string | undefined {
  const origin = event.origin as { kind?: unknown } | undefined
  if (typeof origin?.kind !== 'string' || USER_ORIGINS.has(origin.kind)) return undefined
  if (peerSender(event)) return undefined
  return transcriptUserText(event)
}

/** Text of a `message.appended` payload when it is a user-role message; else undefined. */
function userMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const m = message as { role?: unknown; content?: unknown }
  if (m.role !== 'user') return undefined
  if (typeof m.content === 'string') return m.content.trim() || undefined
  if (Array.isArray(m.content)) {
    const text = m.content
      .map((p) => (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : ''))
      .join('\n')
      .trim()
    return text || undefined
  }
  return undefined
}
