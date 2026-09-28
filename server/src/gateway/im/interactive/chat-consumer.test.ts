import { describe, expect, it, vi } from 'vitest'
import type { TextStreamPart, ToolSet } from 'ai'
import type { DiffPreviewService } from '../../diff-preview-service.js'
import type { IMProvider } from '../types.js'
import type { PermissionHandler } from '../permission-handler.js'
import { consumeFullStream } from './chat-consumer.js'

type StreamEvent = TextStreamPart<ToolSet>

function event(value: Record<string, unknown>): StreamEvent {
  return value as StreamEvent
}

async function* stream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const item of events) yield item
}

function setup(onStatus?: () => void) {
  const calls: string[] = []
  const provider = {
    createStreamWriter: () => ({
      update: vi.fn(async () => {}),
      finish: async (text: string) => {
        calls.push(`final:${text}`)
        return 'final-1'
      },
      abort: vi.fn(),
    }),
    sendToolNotification: async (_ref: unknown, text: string) => {
      calls.push(`status:${text}`)
      onStatus?.()
      return 'status-1'
    },
    updateToolNotification: async (_ref: unknown, id: string, text: string) => {
      calls.push(`edit:${id}:${text}`)
    },
    deleteToolNotification: async (_ref: unknown, id: string) => {
      calls.push(`delete:${id}`)
    },
    send: async (_ref: unknown, text: string) => {
      calls.push(`send:${text}`)
      return { sourceTs: 'error-1' }
    },
  } as unknown as IMProvider

  const run = (events: StreamEvent[], signal = new AbortController().signal) =>
    consumeFullStream({
      provider,
      ref: { sourceChannel: 'channel-1' },
      channelKey: 'channel-1',
      fullStream: stream(events),
      internalChatId: 1,
      signal,
      permissionHandler: {} as PermissionHandler,
      diffPreviewService: { isEnabled: () => false } as DiffPreviewService,
    })

  return { calls, run }
}

describe('interactive gateway progress', () => {
  it('reuses one status for thinking and tools, then deletes it after the final answer', async () => {
    const { calls, run } = setup()
    await run([
      event({ type: 'reasoning-start' }),
      event({ type: 'reasoning-end' }),
      event({ type: 'text-delta', text: 'I will search first.' }),
      event({ type: 'tool-input-start', toolCallId: 'a', toolName: 'grep' }),
      event({ type: 'tool-call', toolCallId: 'a', toolName: 'grep', input: { pattern: 'foo' } }),
      event({ type: 'tool-result', toolCallId: 'a', toolName: 'grep', output: 'found' }),
      event({ type: 'tool-call', toolCallId: 'b', toolName: 'read', input: { path: '/tmp/file' } }),
      event({ type: 'tool-result', toolCallId: 'b', toolName: 'read', output: 'content' }),
      event({ type: 'text-delta', text: 'Here is the answer.' }),
      event({ type: 'finish' }),
    ])

    expect(calls.filter((call) => call.startsWith('status:'))).toEqual(['status:⏳ Working...'])
    expect(calls).toContain('edit:status-1:🧠 Thinking...')
    expect(calls).toContain('edit:status-1:🔎 Grep `foo`')
    expect(calls).toContain('edit:status-1:📖 Read file')
    expect(calls).not.toContain('final:I will search first.')
    expect(calls.at(-2)).toBe('final:Here is the answer.')
    expect(calls.at(-1)).toBe('delete:status-1')
  })

  it('does not replace the latest tool with an older tool result', async () => {
    const { calls, run } = setup()
    await run([
      event({ type: 'tool-call', toolCallId: 'a', toolName: 'grep', input: { pattern: 'old' } }),
      event({ type: 'tool-call', toolCallId: 'b', toolName: 'read', input: { path: '/tmp/new' } }),
      event({ type: 'tool-result', toolCallId: 'a', toolName: 'grep', output: 'done' }),
      event({ type: 'text-delta', text: 'Done.' }),
      event({ type: 'finish' }),
    ])

    expect(calls).not.toContain('edit:status-1:✅ 🔎 Grep `old`')
    expect(calls).toContain('edit:status-1:📖 Read new')
    expect(calls.at(-1)).toBe('delete:status-1')
  })

  it('cleans up the status when the turn is aborted', async () => {
    const controller = new AbortController()
    const { calls, run } = setup(() => controller.abort())
    await run([event({ type: 'text-delta', text: 'Unfinished' })], controller.signal)

    expect(calls).toEqual(['status:⏳ Working...', 'delete:status-1'])
  })

  it('does not invent a final reply when a turn finishes without text', async () => {
    const { calls, run } = setup()
    await run([
      event({ type: 'tool-call', toolCallId: 'a', toolName: 'read', input: { path: '/tmp/file' } }),
      event({ type: 'finish' }),
    ])

    expect(calls.some((call) => call.startsWith('final:'))).toBe(false)
    expect(calls.at(-1)).toBe('delete:status-1')
  })
})
