import { describe, expect, it } from 'vitest'
import { aiRoutes } from './ai.js'
import { beginChatTurn, emitChatTurnFinished, markChatTurnReady } from '../services/ai/chat-turn-lifecycle.js'
import { TurnStream } from '../services/ai/turn-stream.js'

// These endpoints only touch the in-memory turn registry, so the storage the
// router takes for the /chat POST path is never reached here.
const storage = {} as unknown as Parameters<typeof aiRoutes>[0]

const finish = (chatId: number, turnId: string) => emitChatTurnFinished({ chatId, turnId, status: 'completed' })

describe('GET /chat/stream/:chatId', () => {
  it('returns 204 when the chat has no turn, so the SDK treats it as nothing to resume', async () => {
    const response = await aiRoutes(storage).request('/chat/stream/1234')
    expect(response.status).toBe(204)
  })

  it("answers with the turn's reply so far as a UI message stream the SDK decodes", async () => {
    const stream = new TurnStream('r1', 'm1')
    beginChatTurn(4242, 'r1', { stream })
    stream.publish({ type: 'start', messageId: 'm1' })
    stream.publish({ type: 'text-start', id: 't' })
    stream.publish({ type: 'text-delta', id: 't', delta: 'Hel' })
    stream.publish({ type: 'text-delta', id: 't', delta: 'lo' })
    stream.end()
    finish(4242, 'r1')

    const response = await aiRoutes(storage).request('/chat/stream/4242')

    expect(response.status).toBe(200)
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    // Only the POST that opened the turn names its chat.
    expect(response.headers.get('X-Chat-Id')).toBeNull()
    const body = await response.text()
    expect(body).toContain('"delta":"Hello"')
    expect(body).toContain('data: [DONE]')
  })

  it('names the turn and its reply, the same turn the status stream announces', async () => {
    const stream = new TurnStream('r2', 'm2')
    beginChatTurn(4545, 'r2', { stream })

    const response = await aiRoutes(storage).request('/chat/stream/4545')

    expect(response.headers.get('X-Turn-Id')).toBe('r2')
    expect(response.headers.get('X-Message-Id')).toBe('m2')
    await response.body?.cancel()
    stream.end()
    finish(4545, 'r2')
  })

  it('returns 204 for a turn kept off screen', async () => {
    beginChatTurn(4646, 'compact')
    const response = await aiRoutes(storage).request('/chat/stream/4646')
    expect(response.status).toBe(204)
    finish(4646, 'compact')
  })
})

describe('GET /chat/status (every chat on one stream)', () => {
  const readFrame = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
    const { value } = await reader.read()
    return new TextDecoder().decode(value)
  }

  it('opens with a snapshot of every chat that has a turn — still starting included', async () => {
    beginChatTurn(5151, 'r1')

    const response = await aiRoutes(storage).request('/chat/status')
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()

    const frame = await readFrame(reader)
    expect(frame).toContain('"type":"sync"')
    expect(frame).toContain('"chatId":5151')
    expect(frame).toContain('"turnId":"r1"')

    await reader.cancel()
    finish(5151, 'r1')
  })

  it('omits idle chats from the snapshot — absence is how a client reads "no turn"', async () => {
    beginChatTurn(5252, 'r1')
    finish(5252, 'r1')

    const response = await aiRoutes(storage).request('/chat/status')
    const reader = response.body!.getReader()

    expect(await readFrame(reader)).not.toContain('"chatId":5252')
    await reader.cancel()
  })

  it('pushes turn start and end for a chat the connection never named', async () => {
    const response = await aiRoutes(storage).request('/chat/status')
    const reader = response.body!.getReader()
    await readFrame(reader) // sync

    // The handler registers its listener as it runs, which `request()` does not
    // wait for. Yield once so this models a client that connected earlier, not a
    // race the real world doesn't have.
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Started AFTER connecting: the whole point of one stream for every chat.
    beginChatTurn(5353, 'r1')
    const started = await readFrame(reader)
    expect(started).toContain('"type":"turn"')
    expect(started).toContain('"chatId":5353')
    expect(started).toContain('"active":true')

    markChatTurnReady(5353, 'r1')
    finish(5353, 'r1')
    const ended = await readFrame(reader)
    expect(ended).toContain('"chatId":5353')
    expect(ended).toContain('"active":false')

    await reader.cancel()
  })
})
