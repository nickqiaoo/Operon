/**
 * Context blocks: text attachments folded into a user message.
 *
 * Selected text, line comments, browser annotations and pasted text all travel
 * as `asText` composer files. On send (`useChatActions`) each one is serialized
 * ahead of what the user typed as
 *
 *     [File: selected-text.md]
 *     ...markdown...
 *     [/File]
 *
 * The model reads that as plain text. The transcript parses it back out so the
 * quote renders as a card instead of a wall of `[File: …]` markup, and so the
 * chat title / navigator show what the user actually asked.
 */

export interface ContextBlock {
  filename: string
  content: string
}

export interface ParsedContextBlocks {
  blocks: ContextBlock[]
  /** Whatever the user typed after the blocks. */
  body: string
}

const OPEN = /^\[File: ([^\]\n]+)\]\n/
const CLOSE = '\n[/File]'

export const wrapContextBlock = (filename: string, content: string): string =>
  `[File: ${filename}]\n${content}${CLOSE}`

/**
 * Split leading `[File: …] … [/File]` blocks off a message. A message written
 * before the closing marker existed doesn't match and comes back untouched as
 * `body`; nothing is guessed.
 */
export const parseContextBlocks = (text: string): ParsedContextBlocks => {
  const blocks: ContextBlock[] = []
  let rest = text
  for (;;) {
    const open = OPEN.exec(rest)
    if (!open) break
    const contentStart = open[0].length
    const closeAt = rest.indexOf(CLOSE, contentStart)
    if (closeAt === -1) break
    blocks.push({ filename: open[1], content: rest.slice(contentStart, closeAt) })
    rest = rest.slice(closeAt + CLOSE.length).replace(/^\n+/, '')
  }
  return { blocks, body: rest }
}

/** The user's own words, with any leading context blocks removed. */
export const stripContextBlocks = (text: string): string => parseContextBlocks(text).body

export type ContextBlockKind = 'selected-text' | 'line-comment' | 'annotation' | 'pasted-text' | 'file'

export interface ContextBlockView {
  kind: ContextBlockKind
  /** File path / location the snippet came from, when the heading carried one. */
  location?: string
  /** Block content minus the heading line the location was lifted from. */
  content: string
  /** Whether `content` is markdown (render it) or plain text (preformat it). */
  markdown: boolean
}

const headingLocation = (content: string, pattern: RegExp): { location?: string; rest: string } | null => {
  const newline = content.indexOf('\n')
  const heading = newline === -1 ? content : content.slice(0, newline)
  const match = pattern.exec(heading)
  if (!match) return null
  const rest = newline === -1 ? '' : content.slice(newline + 1).replace(/^\n+/, '')
  return { location: match[1], rest }
}

/** Classify a block by the filename its source gave it, and lift its location. */
export const describeContextBlock = (block: ContextBlock): ContextBlockView => {
  const { filename, content } = block
  if (filename === 'selected-text.md') {
    // `Selected from \`path (line 3-9)\`:` or bare `Selected text:`
    const lifted =
      headingLocation(content, /^Selected from `([^`]+)`:$/) ??
      headingLocation(content, /^Selected (text):$/)
    return {
      kind: 'selected-text',
      location: lifted?.location === 'text' ? undefined : lifted?.location,
      content: lifted?.rest ?? content,
      markdown: true,
    }
  }
  if (filename === 'line-comment.md') {
    // `Comment on \`path\` (line 3-9):`
    const lifted = headingLocation(content, /^Comment on `([^`]+)` \((line [^)]+)\):$/)
    const heading = /^Comment on `([^`]+)` \((line [^)]+)\):/.exec(content)
    return {
      kind: 'line-comment',
      location: heading ? `${heading[1]} (${heading[2]})` : undefined,
      content: lifted?.rest ?? content,
      markdown: true,
    }
  }
  if (filename === 'annotation.md') {
    return { kind: 'annotation', content, markdown: true }
  }
  if (/^pasted_text_.*\.txt$/.test(filename)) {
    return { kind: 'pasted-text', content, markdown: false }
  }
  return {
    kind: 'file',
    location: filename,
    content,
    markdown: /\.(md|markdown)$/i.test(filename),
  }
}
