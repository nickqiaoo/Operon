import { describe, expect, it } from 'vitest'
import { GeminiEventType } from '@google/gemini-cli-core'
import type { ModelMessage } from 'ai'
import { GeminiRuntimeSession } from './session.js'

function withTimeout<T>(promise: Promise<T>, ms = 100): Promise<T | 'timeout'> {
  return Promise.race([
    promise,
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), ms)
    }),
  ])
}

describe('GeminiRuntimeSession', () => {
  it('streams text parts before the turn finishes', async () => {
    let releaseTurn!: () => void
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })

    const session = new GeminiRuntimeSession({
      cwd: '/tmp',
      modelId: 'gemini-2.5-pro',
      modeId: 'Default',
    })

    ;(session as unknown as {
      coreConfig: { getSessionId: () => string | undefined }
      geminiClient: {
        sendMessageStream: (request: unknown, signal: AbortSignal, promptId: string) => AsyncGenerator<unknown, unknown>
      }
      chatStarted: boolean
    }).coreConfig = {
      getSessionId: () => 'session-1',
    }

    ;(session as unknown as {
      coreConfig: { getSessionId: () => string | undefined }
      geminiClient: {
        sendMessageStream: (request: unknown, signal: AbortSignal, promptId: string) => AsyncGenerator<unknown, unknown>
      }
      chatStarted: boolean
    }).geminiClient = {
      async *sendMessageStream() {
        yield { type: GeminiEventType.Content, value: 'Hello' }
        await turnGate
        yield {
          type: GeminiEventType.Finished,
          value: {
            reason: 'STOP',
            usageMetadata: {
              promptTokenCount: 3,
              candidatesTokenCount: 1,
            },
          },
        }
        return { pendingToolCalls: [] }
      },
    }

    ;(session as unknown as { chatStarted: boolean }).chatStarted = true

    const iterator = session.stream({
      requestId: 'req-1',
      messages: [{ role: 'user', content: 'hi' } as ModelMessage],
    })[Symbol.asyncIterator]()

    expect((await iterator.next()).value).toMatchObject({ type: 'start' })
    expect((await iterator.next()).value).toMatchObject({ type: 'start-step' })

    const textStart = await withTimeout(iterator.next())
    expect(textStart).not.toBe('timeout')
    expect((textStart as IteratorResult<unknown>).value).toMatchObject({ type: 'text-start' })

    const textDelta = await withTimeout(iterator.next())
    expect(textDelta).not.toBe('timeout')
    expect((textDelta as IteratorResult<unknown>).value).toMatchObject({
      type: 'text-delta',
      text: 'Hello',
    })

    releaseTurn()

    const textEnd = await iterator.next()
    expect(textEnd.value).toMatchObject({ type: 'text-end' })

    const metadata = await iterator.next()
    expect(metadata.value).toMatchObject({ type: 'message-metadata' })

    const finishStep = await iterator.next()
    expect(finishStep.value).toMatchObject({
      type: 'finish-step',
      finishReason: 'stop',
      rawFinishReason: 'STOP',
    })

    const finish = await iterator.next()
    expect(finish.value).toMatchObject({ type: 'finish' })

    const done = await iterator.next()
    expect(done.done).toBe(true)
  })
})
