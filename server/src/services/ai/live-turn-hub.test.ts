import { describe, expect, it } from 'vitest'
import {
  startLiveTurn,
  getLiveTurn,
  getLiveTurnStatus,
  subscribeLiveTurnPresence,
  pumpToLiveTurn,
  type LiveTurnStatus,
} from './live-turn-hub'

const enc = new TextEncoder()
const dec = new TextDecoder()

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
    turn.append(enc.encode('a'))
    turn.append(enc.encode('b'))

    // Attach after the fact, then let the turn finish.
    const attached = collect(turn.toReadableStream())
    turn.append(enc.encode('c'))
    turn.finish()

    expect(await attached).toBe('abc')
  })

  it('tails a running turn from the start, for every concurrent attacher', async () => {
    const chatId = freshChatId()
    const turn = startLiveTurn(chatId, {})
    turn.append(enc.encode('one'))

    const first = collect(turn.toReadableStream())
    const second = collect(turn.toReadableStream())
    // Yield so both readers drain the backlog and park on the waiter.
    await new Promise((resolve) => setTimeout(resolve, 0))
    turn.append(enc.encode('two'))
    turn.finish()

    expect(await first).toBe('onetwo')
    expect(await second).toBe('onetwo')
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
    turn.append(enc.encode('x'))

    const ac = new AbortController()
    const attached = collect(turn.toReadableStream(ac.signal))
    await new Promise((resolve) => setTimeout(resolve, 0))
    ac.abort()

    expect(await attached).toBe('x')
    // The turn itself is untouched — a second surface still sees the rest.
    expect(turn.isDone).toBe(false)
    turn.append(enc.encode('y'))
    turn.finish()
    expect(await collect(turn.toReadableStream())).toBe('xy')
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

    await pumpToLiveTurn(sourceOf(['done']), turn)
    expect(seen[seen.length - 1]?.active).toBe(false)
    expect(getLiveTurnStatus(chatId).active).toBe(false)

    unsub()
  })

  it('supersedes the previous turn so a stale attacher is released', async () => {
    const chatId = freshChatId()
    const first = startLiveTurn(chatId, {})
    first.append(enc.encode('old'))
    const stale = collect(first.toReadableStream())

    const second = startLiveTurn(chatId, {})
    // The superseded turn ends, so anyone tailing it stops instead of hanging.
    expect(await stale).toBe('old')
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
    const [toRequester, toHub] = sourceOf(['head', 'tail']).tee()
    void toRequester.cancel()
    await pumpToLiveTurn(toHub, turn)

    expect(await collect(turn.toReadableStream())).toBe('headtail')
  })
})
