import { describe, it, expect, beforeEach } from 'vitest'
import { FakeRuntimeProvider, type FakeScript } from './index.js'
import type { RuntimeStreamPart } from '../../types.js'

beforeEach(() => {
  FakeRuntimeProvider.resetScripts()
})

async function collect(provider: FakeRuntimeProvider): Promise<RuntimeStreamPart[]> {
  const session = await provider.createSession({ cwd: '/tmp' })
  const parts: RuntimeStreamPart[] = []
  for await (const part of session.stream({ requestId: 'r1', messages: [] })) {
    parts.push(part)
  }
  return parts
}

describe('FakeRuntimeProvider', () => {
  it('runs the default script when none is configured', async () => {
    const parts = await collect(new FakeRuntimeProvider())
    expect(parts.some((p) => p.type === 'text-delta')).toBe(true)
    expect(parts.some((p) => p.type === 'finish')).toBe(true)
  })

  it('throws when the named script is missing', async () => {
    FakeRuntimeProvider.currentScript = 'no-such-script'
    const provider = new FakeRuntimeProvider()
    const session = await provider.createSession({ cwd: '/tmp' })
    await expect(async () => {
      for await (const _p of session.stream({ requestId: 'x', messages: [] })) {
        // drain
      }
    }).rejects.toThrow(/no-such-script/)
  })

  it('extracts the last user message text and exposes it via session.userMessage', async () => {
    let observed = ''
    const probeScript: FakeScript = async function* ({ session }) {
      observed = session.userMessage
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      } as RuntimeStreamPart
    }
    FakeRuntimeProvider.scripts.set('probe', probeScript)
    FakeRuntimeProvider.currentScript = 'probe'

    const provider = new FakeRuntimeProvider()
    const session = await provider.createSession({ cwd: '/tmp' })
    for await (const _p of session.stream({
      requestId: 'r1',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'most recent' },
      ],
    })) {
      // drain
    }
    expect(observed).toBe('most recent')
  })

  it('increments turnIndex across stream() calls on the same session', async () => {
    const observed: number[] = []
    FakeRuntimeProvider.scripts.set('count', async function* ({ session }) {
      observed.push(session.turnIndex)
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      } as RuntimeStreamPart
    })
    FakeRuntimeProvider.currentScript = 'count'

    const provider = new FakeRuntimeProvider()
    const session = await provider.createSession({ cwd: '/tmp' })
    for (let i = 0; i < 3; i += 1) {
      for await (const _p of session.stream({ requestId: `r${i}`, messages: [] })) {
        // drain
      }
    }
    expect(observed).toEqual([0, 1, 2])
  })

  it('abort() stops streaming and rejects pending permissions', async () => {
    let pendingResolved = false
    let pendingRejected = false
    FakeRuntimeProvider.scripts.set('blocker', async function* ({ session }) {
      const approvalId = 'a1'
      yield {
        type: 'tool-approval-request',
        approvalId,
        toolCall: {
          type: 'tool-call',
          toolCallId: approvalId,
          toolName: 'wait',
          input: {},
          providerExecuted: false,
          dynamic: false,
        },
      } as RuntimeStreamPart
      try {
        await session.waitForPermission(approvalId)
        pendingResolved = true
      } catch {
        pendingRejected = true
      }
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      } as RuntimeStreamPart
    })
    FakeRuntimeProvider.currentScript = 'blocker'

    const provider = new FakeRuntimeProvider()
    const session = await provider.createSession({ cwd: '/tmp' })
    const iterator = session.stream({ requestId: 'r1', messages: [] })[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value?.type).toBe('tool-approval-request')

    session.abort()

    // Drain remaining; should terminate without yielding finish.
    let yieldedAfterAbort = 0
    while (true) {
      const r = await iterator.next()
      if (r.done) break
      yieldedAfterAbort += 1
    }
    expect(yieldedAfterAbort).toBe(0)
    expect(pendingResolved).toBe(false)
    expect(pendingRejected).toBe(true)
  })

  it('resolvePermission unblocks waitForPermission with the decision', async () => {
    const decisions: unknown[] = []
    FakeRuntimeProvider.scripts.set('perm', async function* ({ session }) {
      const approvalId = 'p1'
      yield {
        type: 'tool-approval-request',
        approvalId,
        toolCall: {
          type: 'tool-call',
          toolCallId: approvalId,
          toolName: 'do',
          input: {},
          providerExecuted: false,
          dynamic: false,
        },
      } as RuntimeStreamPart
      const decision = await session.waitForPermission(approvalId)
      decisions.push(decision)
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      } as RuntimeStreamPart
    })
    FakeRuntimeProvider.currentScript = 'perm'

    const provider = new FakeRuntimeProvider()
    const session = await provider.createSession({ cwd: '/tmp' })
    const iterator = session.stream({ requestId: 'r1', messages: [] })[Symbol.asyncIterator]()
    const approval = await iterator.next()
    expect(approval.value?.type).toBe('tool-approval-request')

    session.resolvePermission('p1', { type: 'allow', updatedInput: { ok: true } })

    let finished = false
    while (true) {
      const r = await iterator.next()
      if (r.done) break
      if (r.value.type === 'finish') finished = true
    }
    expect(finished).toBe(true)
    expect(decisions).toEqual([{ type: 'allow', updatedInput: { ok: true } }])
  })
})
