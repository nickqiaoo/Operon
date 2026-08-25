import { describe, expect, it } from 'vitest'
import { aiRoutes } from './ai.js'
import { emitPresence, startLiveTurn } from '../services/ai/live-turn-hub.js'
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

  // Regression guard for shipped clients. This endpoint is superseded by the
  // all-chats stream, but an iOS build already on someone's phone still calls it
  // — App Store review means old versions outlive a node upgrade by months. The
  // fan-out in emitPresence now feeds two listener sets; this proves adding the
  // second one did not orphan the first.
  it('still pushes turn start/end to a per-chat subscriber', async () => {
    const response = await aiRoutes(storage).request('/chat/live-status/4646')
    const reader = response.body!.getReader()
    const decode = async (): Promise<string> =>
      new TextDecoder().decode((await reader.read()).value)

    expect(await decode()).toContain('"active":false')
    await new Promise((resolve) => setTimeout(resolve, 20))

    const turn = startLiveTurn(4646, streamHeaders)
    const started = await decode()
    expect(started).toContain('"active":true')
    expect(started).toContain(`"turnId":"${turn.turnId}"`)

    turn.finish()
    emitPresence(4646)
    expect(await decode()).toContain('"active":false')

    await reader.cancel()
  })
})

describe('GET /chat/live-status (all chats on one stream)', () => {
  const readFrame = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
    const { value } = await reader.read()
    return new TextDecoder().decode(value)
  }

  it('opens with a snapshot of every chat currently running a turn', async () => {
    const turn = startLiveTurn(5151, streamHeaders)

    const response = await aiRoutes(storage).request('/chat/live-status')
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()

    const frame = await readFrame(reader)
    expect(frame).toContain('"type":"sync"')
    expect(frame).toContain('"chatId":5151')
    expect(frame).toContain(`"turnId":"${turn.turnId}"`)

    await reader.cancel()
    turn.finish()
  })

  it('omits idle chats from the snapshot — absence is how a client reads "no live turn"', async () => {
    const finished = startLiveTurn(5252, streamHeaders)
    finished.finish()

    const response = await aiRoutes(storage).request('/chat/live-status')
    const reader = response.body!.getReader()

    expect(await readFrame(reader)).not.toContain('"chatId":5252')
    await reader.cancel()
  })

  it('pushes turn start and end for a chat the connection never named', async () => {
    const response = await aiRoutes(storage).request('/chat/live-status')
    const reader = response.body!.getReader()
    await readFrame(reader) // sync

    // The handler registers its listener as it runs, which `request()` does not
    // wait for. Yield once so this models a client that connected earlier, not a
    // race the real world doesn't have.
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Started AFTER connecting: the whole point of one stream for every chat.
    const turn = startLiveTurn(5353, streamHeaders)
    const started = await readFrame(reader)
    expect(started).toContain('"type":"presence"')
    expect(started).toContain('"chatId":5353')
    expect(started).toContain('"active":true')

    // How a turn really ends: the pump finishes the buffer and announces it
    // (live-turn-hub.ts). `finish()` alone is the low-level half and emits
    // nothing, so calling just that here would not model anything real.
    turn.finish()
    emitPresence(5353)
    const ended = await readFrame(reader)
    expect(ended).toContain('"chatId":5353')
    expect(ended).toContain('"active":false')

    await reader.cancel()
  })
})

describe('old and new clients on the same node', () => {
  // The realistic upgrade state: someone updates the desktop app (all-chats
  // stream) while the phone still runs a build that opens one stream per chat.
  // Both watch the same conversation and both must see the same turn.
  it('serves a per-chat subscriber and an all-chats subscriber the same turn', async () => {
    const routes = aiRoutes(storage)
    const legacy = (await routes.request('/chat/live-status/4747')).body!.getReader()
    const merged = (await routes.request('/chat/live-status')).body!.getReader()

    const decode = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> =>
      new TextDecoder().decode((await reader.read()).value)

    expect(await decode(legacy)).toContain('"active":false')
    expect(await decode(merged)).toContain('"type":"sync"')
    await new Promise((resolve) => setTimeout(resolve, 20))

    const turn = startLiveTurn(4747, streamHeaders)

    const onLegacy = await decode(legacy)
    const onMerged = await decode(merged)
    expect(onLegacy).toContain(`"turnId":"${turn.turnId}"`)
    expect(onMerged).toContain(`"turnId":"${turn.turnId}"`)
    // Same turn, different envelopes: the legacy stream sends a bare status, the
    // merged one wraps it so the client can tell which chat it belongs to.
    expect(onMerged).toContain('"type":"presence"')
    expect(onLegacy).not.toContain('"type":"presence"')

    turn.finish()
    emitPresence(4747)
    expect(await decode(legacy)).toContain('"active":false')
    expect(await decode(merged)).toContain('"active":false')

    await legacy.cancel()
    await merged.cancel()
  })
})
