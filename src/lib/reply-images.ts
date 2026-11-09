import { CITATION_TOKEN_RE, parseCitationPath } from "@/lib/file-citation"
import { IMAGE_EXTENSIONS, isImageFilePath } from "@/lib/file-preview"

/**
 * Local images an agent's reply talks about. Agents finish with lines like
 * "Screenshots: /tmp/run/1-card.png"; the reply shows those files in a gallery
 * under its text, and the path stays in the prose so it can still be copied.
 *
 * Only absolute paths count. A workspace-relative `public/logo.png` is usually a
 * file the agent edited, not a picture it wants to show.
 */

/** A line that opens or closes a fenced code block. */
export const CODE_FENCE_LINE = /^(\s*)(`{3,}|~{3,})([^\n]*)$/

const LINE_PREFIX_RE = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?/
const INLINE_CODE_SOURCE = "(`+)([^\\n]*?)\\1"
const LINK_TARGET_SOURCE = "\\(\\s*(<[^>\\n]*>|[^)\\s]+)(?:\\s+(?:\"[^\"\\n]*\"|'[^'\\n]*'))?\\s*\\)"

const INLINE_CODE_RE = new RegExp(INLINE_CODE_SOURCE, "g")
const MARKDOWN_LINK_RE = new RegExp(`!?\\[[^\\]\\n]*\\]${LINK_TARGET_SOURCE}`, "g")
// Inline code is matched first so an image written inside backticks stays literal.
const CODE_OR_MARKDOWN_IMAGE_RE = new RegExp(`${INLINE_CODE_SOURCE}|!\\[([^\\]\\n]*)\\]${LINK_TARGET_SOURCE}`, "g")

/**
 * A path in running text. The lookbehind rejects URLs and relative paths, whose
 * later segments also start with a slash. The lookahead rejects `a.png.bak`.
 * CJK text can touch either end, as Chinese replies don't space around paths.
 */
const BARE_IMAGE_PATH_RE = new RegExp(
  `(?<![\\w./:~@-])/[^\\s\`"'<>()（）【】「」『』，。；：！？、|*]+?\\.(?:${IMAGE_EXTENSIONS.join("|")})(?![\\w/-]|\\.\\w)`,
  "gi",
)

function isLocalAbsolutePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//")
}

function asLocalImagePath(candidate: string): string | null {
  const path = candidate.trim()
  return isLocalAbsolutePath(path) && isImageFilePath(path) ? path : null
}

/** Markdown percent-encodes link targets, so a path with spaces or CJK arrives encoded. */
export function decodeLocalPath(path: string): string {
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}

function unwrapLinkTarget(target: string): string {
  return target.replace(/^<|>$/g, "")
}

function basename(path: string): string {
  return path.split("/").pop() || path
}

function classifyLines(text: string): { line: string; prose: boolean }[] {
  let openFence: string | null = null
  return text.split("\n").map((line) => {
    const marker = line.match(CODE_FENCE_LINE)?.[2]
    if (marker) {
      if (!openFence) openFence = marker
      else if (openFence[0] === marker[0] && marker.length >= openFence.length) openFence = null
      return { line, prose: false }
    }
    return { line, prose: !openFence }
  })
}

/** The tokens' paths are recorded by `found`; blanking keeps later offsets valid. */
function consume(line: string, pattern: RegExp, read: (match: RegExpExecArray) => string | null, found: { index: number; path: string }[]): string {
  let rest = line
  for (const match of line.matchAll(pattern)) {
    const path = read(match as RegExpExecArray)
    if (path) found.push({ index: match.index, path })
    rest = rest.slice(0, match.index) + " ".repeat(match[0].length) + rest.slice(match.index + match[0].length)
  }
  return rest
}

function citationPath(token: string): string | null {
  const inner = token.replace(/^【|†L.*】$/g, "")
  const path = parseCitationPath(inner)
  return path && asLocalImagePath(path)
}

function imagePathsInLine(line: string): string[] {
  const found: { index: number; path: string }[] = []
  let rest = consume(line, INLINE_CODE_RE, (m) => {
    const code = m[2].trim()
    return code.startsWith("【") ? citationPath(code) : asLocalImagePath(code)
  }, found)
  rest = consume(rest, CITATION_TOKEN_RE, (m) => citationPath(m[0]), found)
  rest = consume(rest, MARKDOWN_LINK_RE, (m) => asLocalImagePath(decodeLocalPath(unwrapLinkTarget(m[1]))), found)
  rest = consume(rest, BARE_IMAGE_PATH_RE, (m) => asLocalImagePath(m[0]), found)

  // Nothing matched: the whole line may be one path with spaces in it.
  if (found.length === 0) {
    const path = asLocalImagePath(line.replace(LINE_PREFIX_RE, ""))
    return path ? [path] : []
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.path)
}

/** Absolute image paths in a reply's prose, in reading order, without duplicates. */
export function extractLocalImagePaths(text: string): string[] {
  const paths = classifyLines(text)
    .filter(({ prose }) => prose)
    .flatMap(({ line }) => imagePathsInLine(line))
  return [...new Set(paths)]
}

/**
 * Turns `![alt](/a.png)` into a link. An `<img>` can't load a local path (it would
 * resolve against the app's own origin), and the gallery shows the picture anyway.
 */
export function linkLocalMarkdownImages(text: string): string {
  if (!text.includes("![")) return text
  return classifyLines(text)
    .map(({ line, prose }) => {
      if (!prose) return line
      return line.replace(CODE_OR_MARKDOWN_IMAGE_RE, (match, _ticks, _code, alt: string | undefined, target: string | undefined) => {
        if (target === undefined) return match
        const path = unwrapLinkTarget(target)
        if (!isLocalAbsolutePath(path)) return match
        const label = alt || basename(decodeLocalPath(path)).replace(/[[\]]/g, "\\$&")
        return `[${label}](${target})`
      })
    })
    .join("\n")
}
