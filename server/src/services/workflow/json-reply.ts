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
