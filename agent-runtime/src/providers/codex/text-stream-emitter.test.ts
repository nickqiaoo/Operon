import { describe, expect, it } from 'vitest'
import type { RuntimeStreamPart } from '../../types.js'
import { CodexTextStreamEmitter } from './text-stream-emitter.js'

function createEmitter(parts: RuntimeStreamPart[]) {
  const controller = {
    enqueue: (part: RuntimeStreamPart) => {
      parts.push(part)
    },
  } as ReadableStreamDefaultController<RuntimeStreamPart>

  return new CodexTextStreamEmitter(controller, {
    threadId: 'thread-1',
    turnId: 'turn-1',
    modelId: 'gpt-5',
  })
}

describe('CodexTextStreamEmitter', () => {
  it('emits message metadata on token usage updates before finish-step', () => {
    const parts: RuntimeStreamPart[] = []
    const emitter = createEmitter(parts)

    emitter.updateTokenUsage({
      last: {
        inputTokens: 1200,
        outputTokens: 45,
        cachedInputTokens: 200,
        reasoningOutputTokens: 10,
        totalTokens: 1245,
      },
      total: {
        inputTokens: 1200,
        outputTokens: 45,
        cachedInputTokens: 200,
        reasoningOutputTokens: 10,
        totalTokens: 1245,
      },
      modelContextWindow: 200000,
    })

    const metadataPart = parts.find(
      (part): part is Extract<RuntimeStreamPart, { type: 'message-metadata' }> =>
        part.type === 'message-metadata',
    )

    expect(metadataPart).toBeDefined()
    expect(metadataPart?.metadata).toMatchObject({
      usage: {
        inputTokens: 1200,
        outputTokens: 45,
      },
      contextUsage: {
        promptTokens: 1200,
        contextWindow: 200000,
      },
    })
  })
})
