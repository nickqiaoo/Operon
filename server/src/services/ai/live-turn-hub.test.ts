import { describe, expect, it } from 'vitest'
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import {
  LiveTurn,
  startLiveTurn,
  getLiveTurn,
  getLiveTurnStatus,
  subscribeLiveTurnPresence,
  pumpToLiveTurn,
  type LiveTurnStatus,
} from './live-turn-hub'

const enc = new TextEncoder()
const dec = new TextDecoder()
/** One SSE event, the unit the hub buffers. */
const ev = (body: string): string => `data: ${body}\n\n`

/** Distinct chat ids per test — the hub is process-global. */
let nextChatId = 9000
const freshChatId = (): number => ++nextChatId

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) out += dec.decode(value)
  }
  return out
}

function sourceOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk))
      controller.close()
    },
  })
}

describe('live turn hub', () => {
  it('replays everything buffered to a late attacher', async () => {
    const chatId = freshChatId()
    const turn = startLiveTurn(chatId, { 'content-type': 'text/event-stream' })
    turn.append(enc.encode(ev('a')))
    turn.append(enc.encode(ev('b')))

    // Attach after the fact, then let the turn finish.
    const attached = collect(turn.toReadableStream())
    turn.append(enc.encode(ev('c')))
    turn.finish()

    expect(await attached).toBe(ev('a') + ev('b') + ev('c'))
  })

  it('tails a running turn from the start, for every concurrent attacher', async () => {
    const chatId = freshChatId()
    const turn = startLiveTurn(chatId, {})
    turn.append(enc.encode(ev('one')))

    const first = collect(turn.toReadableStream())
    const second = collect(turn.toReadableStream())
    // Yield so both readers drain the backlog and park on the waiter.
    await new Promise((resolve) => setTimeout(resolve, 0))
    turn.append(enc.encode(ev('two')))
    turn.finish()

    expect(await first).toBe(ev('one') + ev('two'))
    expect(await second).toBe(ev('one') + ev('two'))
  })

  it('ends an attacher when the turn finishes with nothing further', async () => {
    const chatId = freshChatId()
    const turn = startLiveTurn(chatId, {})
    const attached = collect(turn.toReadableStream())
    turn.finish()
    expect(await attached).toBe('')
  })

  it('stops an attacher when its own request aborts, leaving the turn running', async () => {
    const chatId = freshChatId()
    const turn = startLiveTurn(chatId, {})
    turn.append(enc.encode(ev('x')))

    const ac = new AbortController()
    const attached = collect(turn.toReadableStream(ac.signal))
    await new Promise((resolve) => setTimeout(resolve, 0))
    ac.abort()

    expect(await attached).toBe(ev('x'))
    // The turn itself is untouched — a second surface still sees the rest.
    expect(turn.isDone).toBe(false)
    turn.append(enc.encode(ev('y')))
    turn.finish()
    expect(await collect(turn.toReadableStream())).toBe(ev('x') + ev('y'))
  })

  it('reports presence on start and on finish', async () => {
    const chatId = freshChatId()
    const seen: LiveTurnStatus[] = []
    const unsub = subscribeLiveTurnPresence(chatId, (status) => seen.push(status))

    expect(getLiveTurnStatus(chatId).active).toBe(false)

    const turn = startLiveTurn(chatId, {})
    expect(seen).toHaveLength(1)
    expect(seen[0]?.active).toBe(true)
    expect(seen[0]?.turnId).toBe(turn.turnId)
    expect(getLiveTurnStatus(chatId).active).toBe(true)

    await pumpToLiveTurn(sourceOf([ev('done')]), turn)
    expect(seen[seen.length - 1]?.active).toBe(false)
    expect(getLiveTurnStatus(chatId).active).toBe(false)

    unsub()
  })

  it('supersedes the previous turn so a stale attacher is released', async () => {
    const chatId = freshChatId()
    const first = startLiveTurn(chatId, {})
    first.append(enc.encode(ev('old')))
    const stale = collect(first.toReadableStream())

    const second = startLiveTurn(chatId, {})
    // The superseded turn ends, so anyone tailing it stops instead of hanging.
    expect(await stale).toBe(ev('old'))
    expect(first.isDone).toBe(true)
    expect(getLiveTurn(chatId)).toBe(second)
    expect(getLiveTurnStatus(chatId).turnId).toBe(second.turnId)

    second.finish()
  })

  it('pumps a tee\'d branch into the buffer and marks the turn done', async () => {
    const chatId = freshChatId()
    const turn = startLiveTurn(chatId, {})
    await pumpToLiveTurn(sourceOf(['data: 1\n\n', 'data: 2\n\n']), turn)

    expect(turn.isDone).toBe(true)
    expect(await collect(turn.toReadableStream())).toBe('data: 1\n\ndata: 2\n\n')
  })

  it('keeps draining into the buffer after the requester branch is cancelled', async () => {
    const chatId = freshChatId()
    const turn = startLiveTurn(chatId, {})

    // Mirrors handleChat: one tee branch feeds the hub, the other is the client
    // response. Cancelling the client branch must not starve the hub.
    //
    // Deliberately not awaited: per the streams spec a tee branch's cancel()
    // promise only settles once BOTH branches are cancelled, so awaiting it here
    // would deadlock against the hub branch we are about to drain.
    const [toRequester, toHub] = sourceOf([ev('head'), ev('tail')]).tee()
    void toRequester.cancel()
    await pumpToLiveTurn(toHub, turn)

    expect(await collect(turn.toReadableStream())).toBe(ev('head') + ev('tail'))
  })

  it('buffers whole events even when the bytes arrive split', async () => {
    const turn = new LiveTurn(freshChatId(), {})
    const event = ev('{"type":"start","messageId":"m1"}')
    turn.append(enc.encode(event.slice(0, 10)))
    expect(turn.snapshot()).toBe('')
    turn.append(enc.encode(event.slice(10) + ev('{"type":"finish"}').slice(0, 5)))
    expect(turn.snapshot()).toBe(event)
    expect(turn.messageId).toBe('m1')
  })
})

/** A reply as the SDK streams it: a start, a long text, a tool call with streamed input and output, more text. */
function replyChunks(textDeltas: number): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [{ type: 'start', messageId: 'reply-1' }, { type: 'start-step' }]
  chunks.push({ type: 'reasoning-start', id: 'r1' })
  for (let i = 0; i < 5; i++) chunks.push({ type: 'reasoning-delta', id: 'r1', delta: `think${i} ` })
  chunks.push({ type: 'reasoning-end', id: 'r1' })
  chunks.push({ type: 'text-start', id: 't1' })
  for (let i = 0; i < textDeltas; i++) chunks.push({ type: 'text-delta', id: 't1', delta: `w${i} ` })
  chunks.push({ type: 'text-end', id: 't1' })
  chunks.push({ type: 'tool-input-start', toolCallId: 'c1', toolName: 'read' })
  for (const piece of ['{"pa', 'th":"', 'a.ts"}']) chunks.push({ type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: piece })
  chunks.push({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'read', input: { path: 'a.ts' } })
  for (let i = 0; i < 3; i++) chunks.push({ type: 'tool-output-available', toolCallId: 'c1', output: `partial ${i}`, preliminary: true })
  chunks.push({ type: 'tool-output-available', toolCallId: 'c1', output: 'final' })
  chunks.push({ type: 'text-start', id: 't2' })
  for (let i = 0; i < 20; i++) chunks.push({ type: 'text-delta', id: 't2', delta: `x${i} ` })
  chunks.push({ type: 'text-end', id: 't2' })
  chunks.push({ type: 'finish-step' }, { type: 'finish' })
  return chunks
}

/** Rebuild the assistant message from raw SSE text, the way an attaching client does. */
async function rebuild(sse: string): Promise<UIMessage | undefined> {
  const chunks = sse
    .split('\n\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)) as UIMessageChunk)
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  let last: UIMessage | undefined
  for await (const message of readUIMessageStream({ stream, terminateOnError: true })) last = message
  return last
}

describe('live turn compaction', () => {
  it('folds a large turn yet replays the same message from the start', async () => {
    const chunks = replyChunks(2_000)
    const raw = chunks.map((chunk) => ev(JSON.stringify(chunk))).join('')
    const turn = new LiveTurn(freshChatId(), {}, { compactBytes: 4_000 })
    for (const chunk of chunks) turn.append(enc.encode(ev(JSON.stringify(chunk))))
    turn.finish()

    const replay = await collect(turn.toReadableStream())
    expect(replay.length).toBeLessThan(raw.length / 3)
    // The opening survives: the old head eviction lost exactly this.
    expect(replay.startsWith(ev('{"type":"start","messageId":"reply-1"}'))).toBe(true)
    expect(await rebuild(replay)).toEqual(await rebuild(raw))
  })

  it('keeps an attacher reading through a compaction where it was', async () => {
    const chunks = replyChunks(400)
    const turn = new LiveTurn(freshChatId(), {}, { compactBytes: 2_000 })
    const half = Math.floor(chunks.length / 2)
    for (const chunk of chunks.slice(0, half)) turn.append(enc.encode(ev(JSON.stringify(chunk))))

    // Attached mid-turn and caught up; compaction then folds what it has read.
    const reader = turn.read()[Symbol.asyncIterator]()
    let seen = ''
    // Drain the backlog; the read that finds nothing left parks until more arrives.
    let parked: Promise<IteratorResult<Uint8Array>> | undefined
    for (;;) {
      const pending = reader.next()
      const next = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), 5))])
      if (next === null) {
        parked = pending
        break
      }
      if (next.done) break
      seen += dec.decode(next.value)
    }
    for (const chunk of chunks.slice(half)) turn.append(enc.encode(ev(JSON.stringify(chunk))))
    turn.finish()
    for (;;) {
      const next = parked ? await parked : await reader.next()
      parked = undefined
      if (next.done) break
      seen += dec.decode(next.value)
    }

    const raw = chunks.map((chunk) => ev(JSON.stringify(chunk))).join('')
    expect(await rebuild(seen)).toEqual(await rebuild(raw))
  })
})
