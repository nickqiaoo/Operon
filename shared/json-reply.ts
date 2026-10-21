/**
 * Read the JSON value an external agent was asked to reply with.
 *
 * External providers cannot take a structured-output tool, so the value comes
 * back as text, and not always bare: a fenced block, or a sentence first — Codex
 * narrates what it is about to do before the object, and that narration is part
 * of the turn's text. The value is taken from wherever it starts.
 */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]
  for (const candidate of [trimmed, fenced]) {
    if (candidate === undefined) continue
    try {
      return JSON.parse(candidate.trim())
    } catch {
      // not bare JSON — look further
    }
  }
  return fromFirstParsableStart(trimmed, '{', '}') ?? fromFirstParsableStart(trimmed, '[', ']')
}

/** Lead-in prose rarely holds a bracket, so a handful of starts is plenty. */
const MAX_STARTS = 20

function fromFirstParsableStart(text: string, open: string, close: string): unknown {
  const end = text.lastIndexOf(close)
  let start = text.indexOf(open)
  for (let tries = 0; start !== -1 && start < end && tries < MAX_STARTS; tries++) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      start = text.indexOf(open, start + 1)
    }
  }
  return undefined
}

/**
 * The JSON value a reply ends with, and the prose before it.
 *
 * For showing a reply rather than consuming one: a structured value is worth
 * drawing as fields, but only when it is what the reply IS. Prose that merely
 * mentions `{braces}` is left alone — the value has to run to the end of the
 * text (a closing fence aside) and be an object or array.
 */
export function splitTrailingJson(text: string): { lead: string; value: Record<string, unknown> | unknown[] } | null {
  const trimmed = text.trim()
  const asStructured = (candidate: string): Record<string, unknown> | unknown[] | null => {
    try {
      const value: unknown = JSON.parse(candidate)
      return value !== null && typeof value === 'object' ? (value as Record<string, unknown> | unknown[]) : null
    } catch {
      return null
    }
  }
  if (trimmed.endsWith('```')) {
    const open = trimmed.lastIndexOf('```', trimmed.length - 4)
    if (open === -1) return null
    const value = asStructured(trimmed.slice(open, -3).replace(/^```(?:json)?/i, '').trim())
    return value ? { lead: trimmed.slice(0, open).trim(), value } : null
  }
  const last = trimmed[trimmed.length - 1]
  if (last !== '}' && last !== ']') return null
  const open = last === '}' ? '{' : '['
  let start = trimmed.indexOf(open)
  for (let tries = 0; start !== -1 && tries < MAX_STARTS; tries++) {
    const value = asStructured(trimmed.slice(start))
    if (value) return { lead: trimmed.slice(0, start).trim(), value }
    start = trimmed.indexOf(open, start + 1)
  }
  return null
}

/** `actOn` → `act on`, `blockedBy` → `blocked by`. */
export function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
}

/** Cap on a one-line summary — the length of a row preview. */
const SUMMARY_CHARS = 280
/** A string value short enough to quote in a one-line summary. */
const SHORT_VALUE = 60

/**
 * A structured reply in one line, for a row that has room for nothing more:
 * its short fields as `key: value`, then its lists as counts —
 * `verdict: pass · 2 issues · 0 rulings`. Long text fields are left to the
 * expanded view.
 */
export function summarizeStructured(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} items`
  if (value === null || typeof value !== 'object') return String(value)
  const scalars: string[] = []
  const lists: string[] = []
  let firstLong: string | undefined
  for (const [key, v] of Object.entries(value)) {
    const label = humanizeKey(key)
    if (Array.isArray(v)) lists.push(`${v.length} ${label}`)
    else if (typeof v === 'number' || typeof v === 'boolean') scalars.push(`${label}: ${v}`)
    else if (typeof v === 'string' && v.trim()) {
      if (v.length <= SHORT_VALUE && !v.includes('\n')) scalars.push(`${label}: ${v}`)
      else firstLong ??= v
    }
  }
  const parts = [...scalars, ...lists]
  const line = parts.length > 0 ? parts.join(' · ') : (firstLong ?? '').replace(/\s+/g, ' ')
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line
}
