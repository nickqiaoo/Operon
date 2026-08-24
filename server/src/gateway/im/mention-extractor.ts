/**
 * Unified inbound mention extraction.
 *
 * Each platform's wire format differs:
 *   - Slack delivers `<@U0AU3QDMH6X>` tokens inline in the raw text. Parse
 *     before `cleanText` strips them.
 *   - Telegram delivers plain text plus a parallel `entities[]` array with
 *     structured offsets. Two entity types resolve to mentions:
 *       * `mention`      — `@username` form; slice the text by offset/length.
 *       * `text_mention` — for users without a public username; the entity
 *         itself carries `user.id`.
 *
 * Returned tokens are platform-canonical identifiers. The registry's selfIndex
 * is keyed by both numeric/user ids (Slack `Uxxx`, Telegram numeric) AND
 * Telegram usernames, so downstream lookup is uniform.
 */

export interface TelegramMessageEntity {
  type: string
  offset: number
  length: number
  user?: { id: number | string }
}

/** Slack: extract `<@U...>` tokens from raw (pre-cleanText) message text. */
export function extractSlackMentions(rawText: string): string[] {
  if (!rawText) return []
  const out: string[] = []
  const re = /<@([A-Z0-9]+)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(rawText)) !== null) out.push(m[1])
  return out
}

/**
 * Telegram: walk the entities array, return usernames for `mention` entries
 * and numeric ids for `text_mention` entries. Falls back to empty when the
 * SDK didn't surface entities (older gramio context, message edits without
 * entities reparse, etc.).
 */
export function extractTelegramMentions(
  text: string,
  entities: TelegramMessageEntity[] | undefined,
): string[] {
  if (!entities?.length || !text) return []
  const out: string[] = []
  for (const e of entities) {
    if (e.type === 'mention') {
      const raw = text.slice(e.offset, e.offset + e.length)
      const username = raw.startsWith('@') ? raw.slice(1) : raw
      if (username) out.push(username)
    } else if (e.type === 'text_mention' && e.user?.id != null) {
      out.push(String(e.user.id))
    }
  }
  return out
}
