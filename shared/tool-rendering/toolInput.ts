/**
 * How a tool's raw input object should be presented.
 *
 * Tools without a dedicated renderer used to dump `JSON.stringify(input)` no
 * matter what they took. We classify by the *shape* of the arguments rather
 * than by tool name: the set of tool names is an unbounded long tail (any MCP
 * server can add more), while the set of argument shapes is small and closed.
 */
export type ToolInputView =
  | { kind: 'empty' }
  | { kind: 'text'; field: string; value: string; language: ToolInputLanguage }
  | { kind: 'fields'; fields: ToolInputField[] }
  | { kind: 'json'; value: unknown }

/** Languages we are willing to guess for a text argument, from its field name. */
export type ToolInputLanguage = 'bash' | 'javascript' | 'markdown'

export interface ToolInputField {
  key: string
  value: string
  /** Render on its own row instead of inline beside the key. */
  multiline: boolean
  /** Set for multiline values, so blocks of code get highlighted. */
  language?: ToolInputLanguage
}

/** A lone string shorter than this reads fine as a key/value row. */
const TEXT_MIN_LENGTH = 80
/** Beyond this a value stops fitting on one line next to its key. */
const FIELD_INLINE_MAX_LENGTH = 120

const SHELL_FIELDS = new Set(['command', 'cmd', 'shell', 'bash'])
/** `source` is what the `node_repl` MCP server calls its JavaScript argument. */
const JS_FIELDS = new Set(['source', 'code', 'script', 'js', 'javascript'])

/** Guess a language from the argument's name — never from its contents. */
export function inferFieldLanguage(key: string): ToolInputLanguage {
  const normalized = key.toLowerCase()
  if (JS_FIELDS.has(normalized)) return 'javascript'
  if (SHELL_FIELDS.has(normalized)) return 'bash'
  return 'markdown'
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function scalarToString(value: unknown): string {
  return value === null ? 'null' : String(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function classifyToolInput(input: unknown): ToolInputView {
  const record = asRecord(input)
  if (!record) return { kind: 'json', value: input }

  const entries = Object.entries(record).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return { kind: 'empty' }

  // A — one field holding a blob of text. JSON escapes every newline into a
  // literal `\n`, which turns a 20-line script into one unreadable line.
  if (entries.length === 1) {
    const [key, value] = entries[0]!
    if (typeof value === 'string' && (value.includes('\n') || value.length > TEXT_MIN_LENGTH)) {
      return { kind: 'text', field: key, value, language: inferFieldLanguage(key) }
    }
  }

  // B — flat scalars, the common MCP shape. A key/value list drops JSON's
  // braces, quotes and commas without losing any information.
  if (entries.every(([, value]) => isScalar(value))) {
    return {
      kind: 'fields',
      fields: entries.map(([key, value]) => {
        const str = scalarToString(value)
        const multiline = str.includes('\n') || str.length > FIELD_INLINE_MAX_LENGTH
        return multiline
          ? { key, value: str, multiline, language: inferFieldLanguage(key) }
          : { key, value: str, multiline }
      }),
    }
  }

  // C — genuinely nested. JSON is the right representation for this.
  return { kind: 'json', value: input }
}
