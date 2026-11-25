import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage, UIMessageChunk } from 'ai'
import type { RuntimeStreamPart } from '@operon/agent-runtime'
import { getChatTurnStream, isChatTurnBusy } from './chat-turn-lifecycle.js'

const saved = vi.hoisted(() => ({ messages: [] as UIMessage[] }))
vi.mock('./state.js', () => ({
  getChatHistoryService: () => ({ getChatMeta: () => ({ sessionId: 's1' }) }),
  getSessionManager: () => ({ get: () => undefined, finishRequest: () => undefined }),
  getChatStorage: () => undefined,
  getAgentFinishCallback: () => undefined,
  getNotificationStorage: () => undefined,
}))
vi.mock('./persistence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./persistence.js')>()),
  createReplyWriter: () => ({
    save: (message: UIMessage) => {
      saved.messages.push(message)
      return { saved: true, bytes: 0 }
    },
  }),
}))

const { runChatTurn } = await import('./chat-flow.js')

const part = (value: Record<string, unknown>): RuntimeStreamPart => value as unknown as RuntimeStreamPart

async function* parts(...items: RuntimeStreamPart[]): AsyncIterable<RuntimeStreamPart> {
  yield* items
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('runChatTurn with its output already on the way', () => {
  beforeEach(() => { saved.messages = [] })

  it('publishes the reply to the chat turn stream and saves it', async () => {
    const turn = await runChatTurn({ chatId: 7001, messages: [] }, {
      output: parts(
        part({ type: 'start' }),
        part({ type: 'start-step', request: {}, warnings: [] }),
        part({ type: 'text-start', id: 't1' }),
        part({ type: 'text-delta', id: 't1', text: 'Done.' }),
        part({ type: 'text-end', id: 't1' }),
        part({ type: 'finish-step', finishReason: 'stop', usage: {} }),
        part({ type: 'finish', finishReason: 'stop', totalUsage: {} }),
      ),
    })
    // Registered like any turn: a tab attaching now finds this stream.
    expect(getChatTurnStream(7001)).toBe(turn.stream)
    const chunks = collect(turn.stream.subscribe())

    const finished = await turn.ended
    expect(finished.status).toBe('completed')
    expect(finished.message?.parts.some((p) => p.type === 'text' && p.text === 'Done.')).toBe(true)
    expect(saved.messages.at(-1)?.id).toBe(turn.assistantMessageId)
    expect(JSON.stringify(await chunks)).toContain('Done.')
    expect(isChatTurnBusy(7001)).toBe(false)
  })

  it('keeps nothing when the agent produced nothing', async () => {
    const turn = await runChatTurn({ chatId: 7002, messages: [] }, { output: parts() })
    const finished = await turn.ended
    expect(finished.message).toBeUndefined()
    expect(saved.messages).toHaveLength(0)
  })

  it('saves the error text when the model call failed before any output', async () => {
    const turn = await runChatTurn({ chatId: 7003, messages: [] }, {
      output: parts(part({ type: 'start' }), part({ type: 'error', error: new Error('rate limited') })),
    })
    const finished = await turn.ended
    expect(finished.status).toBe('failed')
    expect(JSON.stringify(finished.message?.parts)).toContain('Error: rate limited')
  })
})
