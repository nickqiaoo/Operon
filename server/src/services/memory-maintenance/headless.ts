import { randomUUID } from 'node:crypto'
import type { ModelMessage } from 'ai'
import { getSessionManager } from '../ai/state.js'
import { runAgentTurn } from '../ai/agent-turn.js'
import { readStreamAsAsyncIterable } from '@operon/agent-runtime'
import { createMaintenanceLogger } from './logger.js'

const logger = createMaintenanceLogger('memory-headless')

export interface HeadlessRunParams {
  providerId: string
  cwd: string
  modelId?: string
  systemPrompt: string
  messages: ModelMessage[]
  signal?: AbortSignal
}

export interface MemoryToolCallRecord {
  toolName: string
  input: unknown
  ok: boolean
  error?: string
}

export interface HeadlessRunResult {
  toolCalls: MemoryToolCallRecord[]
  memoryUpserts: number
  memorySearches: number
  tokensInput: number
  tokensOutput: number
  finishReason: 'done' | 'error' | 'aborted'
  error?: string
}

const MEMORY_TOOL_PATTERN = /(^|__)memory_(search|get|upsert|timeline)$/

function isMemoryTool(name: string | undefined): boolean {
  return !!name && MEMORY_TOOL_PATTERN.test(name)
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…[+${s.length - max} chars]`
}

function stringifyOutput(output: unknown): string {
  if (output == null) return ''
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parseMemoryToolStatus(output: unknown): string | undefined {
  if (typeof output === 'string') {
    const parsed = parseJsonObject(output)
    return typeof parsed?.status === 'string' ? parsed.status : undefined
  }
  if (!isRecord(output)) return undefined
  if (typeof output.text === 'string') {
    const parsed = parseJsonObject(output.text)
    return typeof parsed?.status === 'string' ? parsed.status : undefined
  }
  const content = output.content
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    if (!isRecord(item) || typeof item.text !== 'string') continue
    const parsed = parseJsonObject(item.text)
    if (typeof parsed?.status === 'string') return parsed.status
  }
  return undefined
}

/**
 * Run a headless LLM session that can call memory_* tools directly.
 *
 * The session is created via the shared SessionManager factory, so it goes
 * through the provider's normal session construction (including MCP tool
 * injection). It never writes to our `chat_history` table — we simply don't
 * pass a chatId and the session is disposed immediately after streaming.
 */
export async function runHeadlessMemoryAgent(params: HeadlessRunParams): Promise<HeadlessRunResult> {
  const manager = getSessionManager()

  const session = await manager.createStandaloneSession(params.providerId, {
    cwd: params.cwd,
    modelId: params.modelId,
    modeId: 'fullAccess',
    // The extraction prompt rides as session instructions — providers ignore
    // system-role messages in `messages`.
    instructions: params.systemPrompt,
  })

  const toolCalls: MemoryToolCallRecord[] = []
  const pendingCalls = new Map<string, MemoryToolCallRecord>()
  let memoryUpserts = 0
  let memorySearches = 0
  let tokensInput = 0
  let tokensOutput = 0
  let finishReason: HeadlessRunResult['finishReason'] = 'done'
  let errorMessage: string | undefined
  let textBuffer = ''
  let reasoningBuffer = ''

  const messages: ModelMessage[] = [...params.messages]

  // Same shared turn core as chat/workflow. We consume the normalized
  // `preparedParts` directly (no SSE/assembly needed) for tool telemetry; the
  // assembly branch behind `done` drains itself, we just don't use it.
  const { preparedParts } = runAgentTurn(session, {
    requestId: randomUUID(),
    messages,
    signal: params.signal ?? new AbortController().signal,
    assistantMessageId: randomUUID(),
    originalMessages: [],
  })

  try {
    for await (const prepared of readStreamAsAsyncIterable(preparedParts)) {
      // Per-step usage arrives already normalized (LanguageModelUsage) — sum it
      // across the run instead of probing raw provider token shapes.
      const usage = prepared.metadata?.usage
      if (usage) {
        if (typeof usage.inputTokens === 'number') tokensInput += usage.inputTokens
        if (typeof usage.outputTokens === 'number') tokensOutput += usage.outputTokens
      }
      const part = prepared.part
      if (!part) continue
      switch (part.type) {
        case 'text-delta': {
          const p = part as unknown as { text?: string; delta?: string }
          const chunk = p.text ?? p.delta ?? ''
          if (chunk) textBuffer += chunk
          break
        }

        case 'reasoning-delta': {
          const p = part as unknown as { text?: string; delta?: string }
          const chunk = p.text ?? p.delta ?? ''
          if (chunk) reasoningBuffer += chunk
          break
        }

        case 'tool-call': {
          const p = part as unknown as {
            toolName?: string
            toolCallId?: string
            input?: unknown
            args?: unknown
          }
          const name = p.toolName
          if (!isMemoryTool(name)) break
          const id = p.toolCallId ?? randomUUID()
          const input = p.input ?? p.args
          // Count at tool-call — every provider emits this. CLI providers also emit
          // tool-result/tool-error, which refine ok/error and back out non-written
          // upserts below. The in-process operon provider emits NO result for its
          // own tools, so the optimistic count is what stands (≈ upsert attempts).
          const record: MemoryToolCallRecord = { toolName: name!, input, ok: true }
          toolCalls.push(record)
          pendingCalls.set(id, record)
          if (name!.endsWith('memory_search')) memorySearches += 1
          if (name!.endsWith('memory_upsert')) memoryUpserts += 1
          logger.info(`tool-call ${name} ${truncate(JSON.stringify(input ?? {}), 400)}`)
          break
        }

        case 'tool-result': {
          const p = part as unknown as {
            toolCallId?: string
            toolName?: string
            output?: unknown
            error?: unknown
          }
          const id = p.toolCallId
          const record = id ? pendingCalls.get(id) : undefined
          if (!record) break
          const err = p.error instanceof Error ? p.error.message : typeof p.error === 'string' ? p.error : undefined
          if (err) {
            record.ok = false
            record.error = err
            if (record.toolName.endsWith('memory_upsert')) memoryUpserts -= 1
            logger.warn(`tool-result ${record.toolName} error: ${err}`)
          } else {
            logger.info(`tool-result ${record.toolName} ok ${truncate(stringifyOutput(p.output), 300)}`)
            // Optimistically counted at tool-call; back it out if it didn't write.
            if (
              record.toolName.endsWith('memory_upsert') &&
              parseMemoryToolStatus(p.output) !== 'written'
            ) {
              memoryUpserts -= 1
            }
          }
          if (id) pendingCalls.delete(id)
          break
        }

        case 'tool-error': {
          const p = part as unknown as { toolCallId?: string; error?: unknown }
          const record = p.toolCallId ? pendingCalls.get(p.toolCallId) : undefined
          if (!record) break
          record.ok = false
          record.error = p.error instanceof Error ? p.error.message : typeof p.error === 'string' ? p.error : 'tool error'
          if (record.toolName.endsWith('memory_upsert')) memoryUpserts -= 1
          logger.warn(`tool-error ${record.toolName}: ${record.error}`)
          if (p.toolCallId) pendingCalls.delete(p.toolCallId)
          break
        }

        case 'error': {
          const p = part as unknown as { error?: unknown }
          errorMessage = p.error instanceof Error ? p.error.message : typeof p.error === 'string' ? p.error : 'unknown stream error'
          finishReason = 'error'
          break
        }

        default:
          break
      }
    }

    if (params.signal?.aborted) finishReason = 'aborted'
  } catch (err) {
    finishReason = params.signal?.aborted ? 'aborted' : 'error'
    errorMessage = err instanceof Error ? err.message : String(err)
  } finally {
    await session.dispose().catch(() => {})
  }

  if (reasoningBuffer.trim()) {
    logger.info(`reasoning: ${truncate(reasoningBuffer.trim(), 800)}`)
  }
  if (textBuffer.trim()) {
    logger.info(`assistant: ${truncate(textBuffer.trim(), 1200)}`)
  } else if (toolCalls.length === 0 && finishReason === 'done') {
    logger.info('assistant: <no text, no tool calls>')
  }
  if (errorMessage) {
    logger.warn(`finish=${finishReason} error=${errorMessage}`)
  }

  return {
    toolCalls,
    memoryUpserts,
    memorySearches,
    tokensInput,
    tokensOutput,
    finishReason,
    error: errorMessage,
  }
}
