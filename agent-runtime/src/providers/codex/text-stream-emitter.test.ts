import { describe, expect, it } from 'vitest'
import type { RuntimeStreamPart } from '../../types.js'
import { CodexTextStreamEmitter, type CodexRateLimitSnapshot } from './text-stream-emitter.js'

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

const snapshot = (
  limitId: string,
  primaryUsedPercent: number,
): CodexRateLimitSnapshot => ({
  limitId,
  limitName: null,
  primary: { usedPercent: primaryUsedPercent, windowDurationMins: 300, resetsAt: 1789746040 },
  secondary: null,
  credits: null,
  planType: 'plus',
})

const lastRateLimits = (parts: RuntimeStreamPart[]) => {
  const metadataParts = parts.filter(
    (part): part is Extract<RuntimeStreamPart, { type: 'message-metadata' }> =>
      part.type === 'message-metadata',
  )
  const metadata = metadataParts.at(-1)?.metadata as
    | { codexRateLimits?: { rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> } }
    | undefined
  return metadata?.codexRateLimits?.rateLimitsByLimitId
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

  it('seeds rate-limit buckets codex never pushed', () => {
    const parts: RuntimeStreamPart[] = []
    const emitter = createEmitter(parts)

    // Only the reserve pool is billed once the plan's 5-hour window is spent.
    emitter.updateRateLimitSnapshot(snapshot('base_model_inference', 34))
    emitter.seedRateLimits(snapshot('codex', 100), {
      codex: snapshot('codex', 100),
      base_model_inference: snapshot('base_model_inference', 12),
    })

    const byLimitId = lastRateLimits(parts)
    expect(Object.keys(byLimitId ?? {}).sort()).toEqual(['base_model_inference', 'codex'])
    // The pushed snapshot wins over the read, which is older by the time it lands.
    expect(byLimitId?.base_model_inference?.primary?.usedPercent).toBe(34)
    expect(byLimitId?.codex?.primary?.usedPercent).toBe(100)
  })

  it('stays quiet when the seed adds nothing', () => {
    const parts: RuntimeStreamPart[] = []
    const emitter = createEmitter(parts)

    emitter.updateRateLimitSnapshot(snapshot('codex', 42))
    const before = parts.length
    emitter.seedRateLimits(snapshot('codex', 40), { codex: snapshot('codex', 40) })

    expect(parts.length).toBe(before)
  })
})
