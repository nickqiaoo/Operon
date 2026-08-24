import { describe, expect, it } from 'vitest'
import { aiRoutes } from './ai.js'
import { startLiveTurn } from '../services/ai/live-turn-hub.js'
import type { SddStorage } from '../services/sdd/sdd-service.js'

// The live-attach endpoints only touch the in-memory hub, so the SDD storage the
// router takes for the /chat POST path is never reached here.
const storage = {} as unknown as SddStorage

const enc = new TextEncoder()

/** Response headers a real UI-message-stream carries (see the AI SDK). */
const streamHeaders = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
  'X-Chat-Id': '4242',
}

describe('GET /chat/live/:chatId', () => {
  it('returns 204 when no turn is buffered, so the SDK treats it as nothing to resume', async () => {
    const response = await aiRoutes(storage).request('/chat/live/1234')
    expect(response.status).toBe(204)
  })

  it('replays the buffered turn with the headers the SDK decodes by', async () => {
    const turn = startLiveTurn(4242, streamHeaders)
    turn.append(enc.encode('data: {"type":"start"}\n\n'))
    turn.finish()

    const response = await aiRoutes(storage).request('/chat/live/4242')

    expect(response.status).toBe(200)
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    // Stripped so the broker doesn't mistake a replay for a fresh turn and open
    // a second buffer over the live one.
    expect(response.headers.get('X-Chat-Id')).toBeNull()
    expect(await response.text()).toBe('data: {"type":"start"}\n\n')
  })

  it('identifies the turn on the replay, so an attacher knows what it joined', async () => {
    const turn = startLiveTurn(4545, streamHeaders)
    turn.finish()

    const response = await aiRoutes(storage).request('/chat/live/4545')

    // Kept (unlike X-Chat-Id): this is how a surface tells a presence event for
    // its own turn from one announcing a peer's.
    expect(response.headers.get('X-Turn-Id')).toBe(turn.turnId)
  })
})

describe('GET /chat/live-status/:chatId', () => {
  it('pushes the current turn state on connect', async () => {
    const turn = startLiveTurn(4343, streamHeaders)

    const response = await aiRoutes(storage).request('/chat/live-status/4343')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    const { value } = await reader.read()
    const frame = new TextDecoder().decode(value)
    expect(frame).toContain('"active":true')
    expect(frame).toContain(`"turnId":"${turn.turnId}"`)

    await reader.cancel()
    turn.finish()
  })

  it('reports an idle chat as inactive', async () => {
    const response = await aiRoutes(storage).request('/chat/live-status/4444')
    const reader = response.body!.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toContain('"active":false')
    await reader.cancel()
  })
})
