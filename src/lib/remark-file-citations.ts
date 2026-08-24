import type { Root, InlineCode, Text, PhrasingContent } from "mdast"
import { CITATION_TOKEN_RE, parseCitationPath, encodeCitation } from "@/lib/file-citation"

/**
 * Remark plugin that turns Codex-style citation tokens (`【F:src/app.ts†L42】`)
 * into inline-code nodes carrying the citation payload. The markdown
 * `inlineCode` component decodes those and renders a clickable FileCitationChip.
 *
 * Only these explicit tokens become clickable — ordinary inline code, prose, and
 * bare/directory names are left untouched, so a citation never resolves to a
 * non-file (the old heuristic did, producing EISDIR/ENOENT on click).
 */
export function remarkFileCitations() {
  return (tree: Root): void => {
    transform(tree as { children?: unknown[] })
  }
}

/** Recursively rewrite text nodes containing citation tokens. Skips code. */
function transform(node: { type?: string; children?: unknown[] }): void {
  if (!Array.isArray(node.children)) return

  const next: unknown[] = []
  for (const raw of node.children) {
    const child = raw as { type?: string; value?: string; children?: unknown[] }
    if (child.type === "text" && typeof child.value === "string" && child.value.includes("【")) {
      next.push(...splitCitations(child.value))
    } else if (child.type === "inlineCode" && typeof child.value === "string") {
      // Tolerate a model that wrapped the whole token in backticks.
      next.push(asCitationCode(child.value) ?? child)
    } else {
      if (child.type !== "code") transform(child)
      next.push(child)
    }
  }
  node.children = next
}

/** If `value` is exactly one file-citation token, returns an encoded inline-code node. */
function asCitationCode(value: string): InlineCode | null {
  CITATION_TOKEN_RE.lastIndex = 0
  const match = CITATION_TOKEN_RE.exec(value.trim())
  if (!match || match[0] !== value.trim()) return null
  const path = parseCitationPath(match[1])
  if (path == null) return null
  const line = Number.parseInt(match[2], 10)
  const endLine = match[3] ? Number.parseInt(match[3], 10) : undefined
  return {
    type: "inlineCode",
    value: encodeCitation({ path, line, ...(endLine != null ? { endLine } : {}) }),
  }
}

/** Splits a text value into text/inline-code parts around each file citation. */
function splitCitations(value: string): PhrasingContent[] {
  const parts: PhrasingContent[] = []
  let cursor = 0
  CITATION_TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CITATION_TOKEN_RE.exec(value)) !== null) {
    const path = parseCitationPath(match[1])
    if (path == null) continue // not a file citation (e.g. missing F:) — leave as text

    if (match.index > cursor) {
      parts.push({ type: "text", value: value.slice(cursor, match.index) } as Text)
    }
    const line = Number.parseInt(match[2], 10)
    const endLine = match[3] ? Number.parseInt(match[3], 10) : undefined
    parts.push({
      type: "inlineCode",
      value: encodeCitation({ path, line, ...(endLine != null ? { endLine } : {}) }),
    } as InlineCode)
    cursor = match.index + match[0].length
  }

  if (parts.length === 0) return [{ type: "text", value } as Text]
  if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) } as Text)
  return parts
}
