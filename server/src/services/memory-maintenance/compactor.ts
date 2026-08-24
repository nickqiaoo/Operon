/**
 * Compress a UIMessage transcript for memory extraction.
 *
 * Raw chat transcripts can exceed 200k tokens because of tool-result
 * payloads (file reads, grep dumps, bash output). Those carry almost zero
 * signal for "what's worth remembering about the user". Stripping them
 * typically shrinks a transcript 5-10x while preserving user intent,
 * assistant decisions, and tool-call purpose.
 */
import type { ModelMessage } from 'ai'

interface UIMessagePart {
  type: string
  text?: string
  toolName?: string
  toolCallId?: string
  input?: unknown
  output?: unknown
  errorText?: string
  filename?: string
  mediaType?: string
  url?: string
  state?: string
}

interface UIMessage {
  id?: string
  role: 'user' | 'assistant' | 'system'
  parts?: UIMessagePart[]
  metadata?: Record<string, unknown>
}

const BASH_RESULT_KEEP_THRESHOLD = 500
const BASH_RESULT_HEAD_TAIL_CHARS = 200
const TOOL_INPUT_TRUNCATE_CHARS = 200
const MEMORY_TOOL_NAMES = new Set([
  'memory_search',
  'memory_get',
  'memory_upsert',
  'memory_timeline',
  'mcp__memory__memory_search',
  'mcp__memory__memory_get',
  'mcp__memory__memory_upsert',
  'mcp__memory__memory_timeline',
])
const READ_LIKE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'read', 'grep', 'glob', 'list'])

function truncate(value: unknown, max: number): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  if (str.length <= max) return str
  return `${str.slice(0, max)}…`
}

function summarizeBashOutput(output: unknown): string {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? null)
  if (text.length <= BASH_RESULT_KEEP_THRESHOLD) return text
  const head = text.slice(0, BASH_RESULT_HEAD_TAIL_CHARS)
  const tail = text.slice(-BASH_RESULT_HEAD_TAIL_CHARS)
  const omitted = text.length - BASH_RESULT_HEAD_TAIL_CHARS * 2
  return `${head}\n…[truncated ${omitted} chars]…\n${tail}`
}

function isMemoryTool(toolName: string | undefined): boolean {
  return !!toolName && MEMORY_TOOL_NAMES.has(toolName)
}

function isReadLikeTool(toolName: string | undefined): boolean {
  if (!toolName) return false
  if (READ_LIKE_TOOLS.has(toolName)) return true
  const lower = toolName.toLowerCase()
  return lower.includes('read') || lower.includes('grep') || lower.includes('glob') || lower.includes('list')
}

function compactPart(part: UIMessagePart): string | null {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return part.text ? part.text : null

    case 'tool-input-available':
    case 'dynamic-tool-input-available': {
      const name = part.toolName ?? 'unknown-tool'
      const inputStr = truncate(part.input, TOOL_INPUT_TRUNCATE_CHARS)
      if (isMemoryTool(name)) return `[tool:${name} input=${inputStr}]`
      return `[tool:${name} ${inputStr}]`
    }

    case 'tool-output-available':
    case 'dynamic-tool-output-available': {
      const name = part.toolName ?? ''
      if (isMemoryTool(name)) {
        return `[tool-result:${name} ${truncate(part.output, 400)}]`
      }
      if (isReadLikeTool(name)) {
        const size = typeof part.output === 'string' ? `${part.output.length} chars` : 'payload'
        return `[tool-result:${name} elided — ${size}]`
      }
      if (name === 'Bash' || name === 'bash') {
        return `[tool-result:${name} ${summarizeBashOutput(part.output)}]`
      }
      return `[tool-result:${name || 'unknown'} ${truncate(part.output, 400)}]`
    }

    case 'tool-output-error':
    case 'dynamic-tool-output-error': {
      const name = part.toolName ?? 'unknown'
      return `[tool-error:${name} ${part.errorText ?? ''}]`
    }

    case 'file': {
      const kind = part.mediaType ?? 'file'
      return `[attachment:${kind} ${part.filename ?? ''}]`
    }

    case 'source-url':
      return part.url ? `[source-url ${part.url}]` : null

    default:
      // Tool-input-available variants come through as `tool-<name>` in some
      // versions of the AI SDK. Capture them generically.
      if (part.type.startsWith('tool-')) {
        const name = part.toolName ?? part.type.slice('tool-'.length)
        if (isMemoryTool(name)) {
          return `[tool:${name} ${truncate(part.input ?? part.output, 400)}]`
        }
        if (part.output !== undefined) {
          return `[tool-result:${name} ${truncate(part.output, 200)}]`
        }
        if (part.input !== undefined) {
          return `[tool:${name} ${truncate(part.input, 200)}]`
        }
      }
      return null
  }
}

function compactMessage(message: UIMessage): string | null {
  const parts = message.parts ?? []
  const pieces = parts.map(compactPart).filter((v): v is string => !!v && v.trim().length > 0)
  if (pieces.length === 0) return null
  return pieces.join('\n')
}

/**
 * Turn a UIMessage transcript into ModelMessage[] ready for an LLM call.
 * Each original message becomes one compacted user/assistant message.
 */
export function compactTranscript(messages: UIMessage[]): ModelMessage[] {
  const out: ModelMessage[] = []
  for (const msg of messages) {
    const body = compactMessage(msg)
    if (!body) continue
    if (msg.role === 'system') continue
    out.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: body,
    } as ModelMessage)
  }
  return out
}

/** Rough token estimate used for chunking decisions. */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length
    else chars += JSON.stringify(m.content).length
  }
  return Math.ceil(chars / 4)
}
