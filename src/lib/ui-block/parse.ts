/**
 * Reads the tags of a ```ui block. The text is usually cut off mid-stream, so
 * the parser keeps every tag that is complete, leaves open elements open (their
 * children so far still count), and stops at the first unfinished tag.
 */

export interface UiSourceNode {
  /** Position in the tree. A node's position never changes as more text arrives. */
  key: string
  type: string
  props: Record<string, string>
  children: UiSourceNode[]
}

export interface UiParseResult {
  nodes: UiSourceNode[]
  /** The text ends inside a tag that may still be completed. */
  pending: boolean
}

export const UI_MAX_NODES = 300
export const UI_MAX_DEPTH = 6

type ReadTag =
  | { kind: 'open'; type: string; props: Record<string, string>; selfClosing: boolean; end: number }
  | { kind: 'close'; type: string; end: number }
  | { kind: 'incomplete' }
  | { kind: 'invalid' }

const INCOMPLETE = { kind: 'incomplete' } as const
const INVALID = { kind: 'invalid' } as const

// No leading underscore, so a prop can never be named __proto__.
const NAME = /[a-zA-Z][\w-]*/y
const WHITESPACE = /\s/

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name])

function readName(source: string, from: number): string | null {
  NAME.lastIndex = from
  return NAME.exec(source)?.[0] ?? null
}

function skipWhitespace(source: string, from: number): number {
  let index = from
  while (index < source.length && WHITESPACE.test(source[index])) index++
  return index
}

function readValue(source: string, from: number): { value: string; end: number } | null {
  const first = source[from]
  if (first === '"' || first === "'") {
    const close = source.indexOf(first, from + 1)
    return close < 0 ? null : { value: decode(source.slice(from + 1, close)), end: close + 1 }
  }
  if (first === '{') {
    const close = source.indexOf('}', from + 1)
    if (close < 0) return null
    return { value: decode(source.slice(from + 1, close).trim().replace(/^(["'])(.*)\1$/, '$2')), end: close + 1 }
  }
  let end = from
  while (end < source.length && !WHITESPACE.test(source[end]) && source[end] !== '>' && source[end] !== '/') end++
  return end === source.length ? null : { value: decode(source.slice(from, end)), end }
}

/** `start` is the index of a `<`. */
function readTag(source: string, start: number): ReadTag {
  let index = start + 1
  if (index >= source.length) return INCOMPLETE
  const closing = source[index] === '/'
  if (closing) index++
  if (index >= source.length) return INCOMPLETE

  const type = readName(source, index)
  if (!type) return INVALID
  index += type.length
  if (index >= source.length) return INCOMPLETE

  if (closing) {
    index = skipWhitespace(source, index)
    if (index >= source.length) return INCOMPLETE
    return source[index] === '>' ? { kind: 'close', type, end: index + 1 } : INVALID
  }

  const props: Record<string, string> = {}
  for (;;) {
    index = skipWhitespace(source, index)
    if (index >= source.length) return INCOMPLETE
    if (source[index] === '>') return { kind: 'open', type, props, selfClosing: false, end: index + 1 }
    if (source[index] === '/') {
      if (index + 1 >= source.length) return INCOMPLETE
      return source[index + 1] === '>' ? { kind: 'open', type, props, selfClosing: true, end: index + 2 } : INVALID
    }

    const name = readName(source, index)
    if (!name) return INVALID
    index += name.length
    if (index >= source.length) return INCOMPLETE

    const afterName = skipWhitespace(source, index)
    if (afterName >= source.length) return INCOMPLETE
    if (source[afterName] !== '=') {
      props[name] = 'true'
      continue
    }
    const valueStart = skipWhitespace(source, afterName + 1)
    if (valueStart >= source.length) return INCOMPLETE
    const read = readValue(source, valueStart)
    if (!read) return INCOMPLETE
    props[name] = read.value
    index = read.end
  }
}

export function parseUi(source: string): UiParseResult {
  const nodes: UiSourceNode[] = []
  const open: UiSourceNode[] = []
  let count = 0
  let index = 0

  for (;;) {
    const start = source.indexOf('<', index)
    if (start < 0) return { nodes, pending: false }

    const tag = readTag(source, start)
    if (tag.kind === 'incomplete') return { nodes, pending: true }
    if (tag.kind === 'invalid') {
      index = start + 1
      continue
    }
    index = tag.end

    if (tag.kind === 'close') {
      for (let depth = open.length - 1; depth >= 0; depth--) {
        if (open[depth].type === tag.type) {
          open.length = depth
          break
        }
      }
      continue
    }

    if (count >= UI_MAX_NODES || open.length >= UI_MAX_DEPTH) return { nodes, pending: false }
    const parent = open.at(-1)
    const siblings = parent ? parent.children : nodes
    const node: UiSourceNode = {
      key: parent ? `${parent.key}.${siblings.length}` : String(siblings.length),
      type: tag.type,
      props: tag.props,
      children: [],
    }
    siblings.push(node)
    count++
    if (!tag.selfClosing) open.push(node)
  }
}
