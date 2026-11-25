import { describe, expect, it } from 'vitest'
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import { TurnStream } from './turn-stream'

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

/** What the AI SDK rebuilds from a chunk sequence — the test of a snapshot. */
async function rebuild(chunks: UIMessageChunk[]): Promise<UIMessage | undefined> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  let last: UIMessage | undefined
  for await (const message of readUIMessageStream({ stream })) last = message
  return last
}

/** A reply with text, reasoning, a tool call and its output, in the order a provider streams them. */
const reply: UIMessageChunk[] = [
  { type: 'start', messageId: 'm1' },
  { type: 'start-step' },
  { type: 'reasoning-start', id: 'r1' },
  { type: 'reasoning-delta', id: 'r1', delta: 'Think' },
  { type: 'reasoning-delta', id: 'r1', delta: 'ing.' },
  { type: 'reasoning-end', id: 'r1' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Hel' },
  { type: 'text-delta', id: 't1', delta: 'lo ' },
  { type: 'text-delta', id: 't1', delta: 'world' },
  { type: 'text-end', id: 't1' },
  { type: 'tool-input-start', toolCallId: 'c1', toolName: 'bash', dynamic: true },
  { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"cmd":' },
  { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '"ls"}' },
  { type: 'tool-input-available', toolCallId: 'c1', toolName: 'bash', input: { cmd: 'ls' }, dynamic: true },
  { type: 'tool-output-available', toolCallId: 'c1', output: 'partial', preliminary: true, dynamic: true },
  { type: 'tool-output-available', toolCallId: 'c1', output: 'a b c', dynamic: true },
  { type: 'data-progress', id: 'p', data: { pct: 10 } },
  { type: 'data-progress', id: 'p', data: { pct: 100 } },
  { type: 'finish-step' },
  { type: 'finish' },
]

describe('turn stream', () => {
  it('hands a late subscriber a folded snapshot that rebuilds the same message', async () => {
    const turn = new TurnStream('t1', 'm1')
    for (const chunk of reply) turn.publish(chunk)
    turn.end()

    const snapshot = await collect(turn.subscribe())
    expect(snapshot.length).toBeLessThan(reply.length)
    expect(snapshot.filter((c) => c.type === 'text-delta')).toEqual([{ type: 'text-delta', id: 't1', delta: 'Hello world' }])
    expect(snapshot.filter((c) => c.type === 'tool-output-available')).toHaveLength(1)
    expect(await rebuild(snapshot)).toEqual(await rebuild(reply))
  })

  it('continues an open part after the snapshot, with nothing lost or doubled', async () => {
    const turn = new TurnStream('t1', 'm1')
    const head = reply.slice(0, 8) // into the text part, still open
    const tail = reply.slice(8)
    for (const chunk of head) turn.publish(chunk)

    const late = collect(turn.subscribe())
    // A delta folded into the snapshot after it was taken must not leak into it.
    for (const chunk of tail) turn.publish(chunk)
    turn.end()

    expect(await rebuild(await late)).toEqual(await rebuild(reply))
  })

  it('gives every concurrent subscriber the whole reply', async () => {
    const turn = new TurnStream('t1', 'm1')
    const early = collect(turn.subscribe())
    for (const chunk of reply.slice(0, 5)) turn.publish(chunk)
    const middle = collect(turn.subscribe())
    for (const chunk of reply.slice(5)) turn.publish(chunk)
    turn.end()

    const expected = await rebuild(reply)
    expect(await early).toEqual(reply)
    expect(await rebuild(await middle)).toEqual(expected)
  })

  it('lets a subscriber leave without affecting the turn or the others', async () => {
    const turn = new TurnStream('t1', 'm1')
    const leaving = turn.subscribe().getReader()
    const staying = collect(turn.subscribe())
    turn.publish(reply[0]!)
    expect((await leaving.read()).value).toEqual(reply[0])
    await leaving.cancel()

    for (const chunk of reply.slice(1)) turn.publish(chunk)
    turn.end()
    expect(await staying).toEqual(reply)
  })

  it('cuts off a subscriber that stops reading, so its backlog cannot grow without bound', async () => {
    const turn = new TurnStream('t1', 'm1')
    const stalled = turn.subscribe().getReader()
    const closed = stalled.closed.then(() => undefined, (error: unknown) => error)
    const reading = collect(turn.subscribe())
    turn.publish({ type: 'start', messageId: 'm1' })
    turn.publish({ type: 'text-start', id: 't' })
    const piece = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 20; i++) {
      turn.publish({ type: 'text-delta', id: 't', delta: piece })
      await new Promise((resolve) => setTimeout(resolve, 0)) // a reader that keeps up gets to read
    }
    turn.publish({ type: 'text-end', id: 't' })
    turn.end()

    // Its stream fails (its client sees a dropped connection and attaches
    // again); the turn and the subscriber that keeps up are unaffected.
    expect(await closed).toBeInstanceOf(Error)
    await expect(stalled.read()).rejects.toThrow('fell behind')
    expect((await reading).filter((c) => c.type === 'text-delta')).toHaveLength(20)
  })

  it('ends a subscriber of a finished turn after the snapshot', async () => {
    const turn = new TurnStream('t1', 'm1')
    turn.publish(reply[0]!)
    turn.end()
    expect(await collect(turn.subscribe())).toEqual([reply[0]])
    turn.publish(reply[1]!) // ignored: the turn is over
    expect(await collect(turn.subscribe())).toEqual([reply[0]])
  })
})
