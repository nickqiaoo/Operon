/** A name that renders as a highlighted `@name` in markdown (a channel member, say). */
export interface MarkdownMention {
  name: string
  /** Extra classes for this name's highlight, e.g. the agent's name color. */
  className?: string
}

/** Classes every mention gets; per-name color comes from `MarkdownMention.className`. */
export const MENTION_BASE_CLASS = "rounded bg-row-selected px-0.5 font-medium"

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Matches `@name` for the given names only. Not preceded by a word char / `.` /
 * `@` (so `me@builder.dev` stays an email), not followed by a name char (so
 * `@builder2` doesn't light up `builder`). Longest names first so `@luna-lead`
 * wins over `@luna`. `escape` maps a name to how it appears in the input — the
 * Words renderer matches against already-escaped HTML.
 */
export function mentionPattern(
  mentions: readonly MarkdownMention[] | undefined,
  escape: (name: string) => string = (name) => name,
): RegExp | null {
  const names = [...new Set((mentions ?? []).map((m) => m.name.trim()).filter(Boolean))]
  if (names.length === 0) return null
  names.sort((a, b) => b.length - a.length)
  const alternation = names.map((name) => escapeRegExp(escape(name))).join("|")
  return new RegExp(`(?<![\\w.@])@(${alternation})(?![\\w-])`, "giu")
}

/** Case-insensitive lookup of a matched name's entry. */
export function findMention(mentions: readonly MarkdownMention[], name: string) {
  const lower = name.toLowerCase()
  return mentions.find((m) => m.name.trim().toLowerCase() === lower)
}
