import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueuedFollowup } from './queued-followup.js'
import type { AgentInput, RuntimeStreamPart } from './types.js'

const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('provider-local followup compatibility', () => {
  it('keeps followups on the same stream, after the original output, with one final finish', async () => {
    const entered = gate(), release = gate()
    const queue = new QueuedFollowup()
    const inputs: AgentInput[] = [], parts: RuntimeStreamPart[] = []
    async function* native(input: AgentInput): AsyncIterable<RuntimeStreamPart> {
      inputs.push(input)
      yield { type: 'start' }
      if (inputs.length === 1) { entered.resolve(); await release.promise }
      yield { type: 'text-start', id: String(input) }
      yield { type: 'text-delta', id: String(input), text: String(input) }
      yield { type: 'text-end', id: String(input) }
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } as RuntimeStreamPart
    }
    const run = (async () => { for await (const part of queue.run('first', undefined, native)) parts.push(part) })()
    await entered.promise
    expect(queue.accept('second', { id: 'input-2' })).toMatchObject({ delivery: 'accepted', mode: 'followup' })
    queue.accept('third')
    expect(inputs).toEqual(['first'])
    release.resolve(); await run
    expect(inputs).toEqual(['first', 'second', 'third'])
    expect(parts.filter((p) => p.type === 'start')).toHaveLength(1)
    expect(parts.filter((p) => p.type === 'finish')).toHaveLength(1)
    expect(parts.filter((p) => p.type === 'text-delta').map((p) => p.text)).toEqual(['first', 'second', 'third'])
    expect(() => queue.accept('idle')).toThrow('No active')
  })

  it('cancels waiting input, and rejects admission once the finish is emitted', async () => {
    const queue = new QueuedFollowup(), entered = gate(), release = gate()
    let calls = 0
    async function* native(): AsyncIterable<RuntimeStreamPart> {
      calls++; entered.resolve(); await release.promise
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } as RuntimeStreamPart
    }
    const run = (async () => {
      for await (const part of queue.run('first', undefined, native)) {
        if (part.type === 'finish') expect(() => queue.accept('too late')).toThrow('No active')
      }
    })()
    await entered.promise; queue.accept('must not run'); queue.cancel(); release.resolve(); await run
    expect(calls).toBe(1)
  })

  const usage = (totalTokens: number) => ({ inputTokens: totalTokens, outputTokens: 0, totalTokens })
  const finishPart = (finishReason: string, tokens = 1) => ({ type: 'finish', finishReason, totalUsage: usage(tokens) }) as RuntimeStreamPart
  const drain = async (stream: AsyncIterable<RuntimeStreamPart>) => { const parts: RuntimeStreamPart[] = []; for await (const p of stream) parts.push(p); return parts }

  it('waits for a stopped run, then starts the new one', async () => {
    const queue = new QueuedFollowup(), entered = gate(), release = gate()
    const old = drain(queue.run('old', undefined, async function* () { entered.resolve(); await release.promise; yield { type: 'abort' } }))
    await entered.promise
    let newStarted = false
    const next = drain(queue.run('new', undefined, async function* () { newStarted = true; yield finishPart('stop') }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(newStarted).toBe(false)
    release.resolve()
    expect(await next).toEqual([finishPart('stop')])
    await old
  })

  describe('with a run that never ends', () => {
    afterEach(() => { vi.useRealTimers() })
    it('moves on after the wait limit', async () => {
      vi.useFakeTimers()
      const queue = new QueuedFollowup(), entered = gate()
      void drain(queue.run('stuck', undefined, async function* () { entered.resolve(); await new Promise(() => {}) }))
      await entered.promise
      const next = drain(queue.run('new', undefined, async function* () { yield finishPart('stop') }))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await next).toEqual([finishPart('stop')])
    })
  })

  it('runs queued input after a failed turn and reports the error last', async () => {
    const queue = new QueuedFollowup(), entered = gate(), release = gate()
    const error = new Error('boom')
    let calls = 0
    const run = drain(queue.run('first', undefined, async function* () {
      if (++calls === 1) { entered.resolve(); await release.promise; yield { type: 'error', error }; yield finishPart('error'); return }
      yield { type: 'text-delta', id: 'x', text: 'followup output' } as RuntimeStreamPart
      yield finishPart('stop')
    }))
    await entered.promise; queue.accept('second'); release.resolve()
    const parts = await run
    expect(parts.map((p) => p.type)).toEqual(['text-delta', 'error', 'finish'])
  })

  it('keeps a stream failure from losing queued input', async () => {
    const queue = new QueuedFollowup(), entered = gate(), release = gate()
    let calls = 0
    const run = drain(queue.run('first', undefined, async function* () {
      if (++calls === 1) { entered.resolve(); await release.promise; throw new Error('connection lost') }
      yield finishPart('stop')
    }))
    await entered.promise; queue.accept('second'); release.resolve()
    expect((await run).map((p) => p.type)).toEqual(['error', 'finish'])
    expect(calls).toBe(2)
  })

  it('sums usage across turns and does not reuse a finished turn\'s finish for an aborted one', async () => {
    const summed = new QueuedFollowup(), entered = gate(), release = gate()
    let calls = 0
    const run = drain(summed.run('first', undefined, async function* () {
      if (++calls === 1) { entered.resolve(); await release.promise }
      yield finishPart('stop', calls === 1 ? 10 : 5)
    }))
    await entered.promise; summed.accept('second'); release.resolve()
    expect((await run).filter((p) => p.type === 'finish')).toEqual([{ type: 'finish', finishReason: 'stop', totalUsage: usage(15) }])

    const aborted = new QueuedFollowup(), entered2 = gate(), release2 = gate()
    let turns = 0
    const run2 = drain(aborted.run('first', undefined, async function* () {
      if (++turns === 1) { entered2.resolve(); await release2.promise; yield finishPart('stop'); return }
      yield { type: 'abort' }
    }))
    await entered2.promise; aborted.accept('second'); release2.resolve()
    expect((await run2).map((p) => p.type)).toEqual(['abort'])
  })
})
