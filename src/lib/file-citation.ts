/**
 * File citations, Codex-style.
 *
 * The model emits an explicit citation token — never plain inline code that
 * "looks like a path" — so directories, bare filenames, and prose mentions are
 * never turned into (broken) clickable links. The token mirrors Codex:
 *
 *   【F:src/app.ts†L42】        -> { path: "src/app.ts", line: 42 }
 *   【F:src/app.ts†L42-L60】    -> { path: "src/app.ts", line: 42, endLine: 60 }
 *
 * `remarkFileCitations` finds these tokens in the rendered markdown and swaps
 * each for an inline-code node whose value carries the citation (see
 * {@link encodeCitation}); the markdown `inlineCode` component decodes it and
 * renders a clickable {@link FileCitationChip}. See the FILE_REFERENCE_PROMPT
 * server rule for the instruction that makes the model emit the token.
 */

export interface FileReference {
  /** File path as written by the model (workspace-relative or absolute). */
  path: string
  /** 1-based start line, if a location was provided. */
  line?: number
  /** 1-based end line for a range, if provided. */
  endLine?: number
}

/**
 * The Codex citation token: `【F:<path>†L<start>(-<end>)?】`. Global so the
 * remark plugin can scan a whole text node. The path is any run of characters
 * that isn't a dagger, closing bracket, or newline; the `F:` prefix (file kind)
 * is validated separately in {@link parseCitationPath}.
 *
 * The range end is lenient: Codex writes `-L<end>`, but other models drop the
 * second `L` (`†L210-216`) or use an en-dash — accept all so a minor format
 * drift doesn't leave the raw token showing in the message.
 */
export const CITATION_TOKEN_RE = /【([^†】\n]+)†L(\d+)(?:\s*[-–]\s*L?(\d+))?】/g

/**
 * Extracts the file path from a token's inner text. Requires the `F:` prefix —
 * that is Codex's marker for a *file* citation (other prefixes are other kinds,
 * e.g. URLs, which we don't render). Returns null for non-file citations.
 */
export function parseCitationPath(rawPath: string): string | null {
  if (!rawPath.startsWith("F:")) return null
  const path = rawPath.slice(2).trim()
  if (!path) return null
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}

/**
 * Private-use sentinel prefixing a citation payload stashed in an inline-code
 * node's value. The character can never appear in model output, so the
 * `inlineCode` component can unambiguously tell a citation from ordinary code.
 */
const CITATION_MARKER = "fc:"

/** Encodes a reference into an inline-code node value the plugin emits. */
export function encodeCitation(ref: FileReference): string {
  return CITATION_MARKER + JSON.stringify(ref)
}

/** Decodes an inline-code node value back into a reference, or null. */
export function decodeCitation(value: string): FileReference | null {
  if (!value.startsWith(CITATION_MARKER)) return null
  try {
    const parsed: unknown = JSON.parse(value.slice(CITATION_MARKER.length))
    if (typeof parsed !== "object" || parsed === null) return null
    const { path, line, endLine } = parsed as Record<string, unknown>
    if (typeof path !== "string" || path.length === 0) return null
    return {
      path,
      line: typeof line === "number" ? line : undefined,
      endLine: typeof endLine === "number" ? endLine : undefined,
    }
  } catch {
    return null
  }
}

/** Builds the location label shown inside the chip, e.g. "line 42" / "lines 10-20". */
export function formatLineLabel(line?: number, endLine?: number): string | null {
  if (line == null) return null
  if (endLine != null && endLine !== line) return `lines ${line}-${endLine}`
  return `line ${line}`
}
