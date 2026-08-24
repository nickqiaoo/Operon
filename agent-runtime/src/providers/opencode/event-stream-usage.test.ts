import { describe, expect, it } from 'vitest'
import {
  convertEventToStreamParts,
  createFinishParts,
  createStreamState,
  type EventMessagePartUpdated,
  type EventMessageUpdated,
} from './event-stream.js'

describe('opencode event stream usage metadata', () => {
  it('uses step-finish usage for mid-stream metadata updates', () => {
    const state = createStreamState()
    state.stepStarted = true

    convertEventToStreamParts({
      type: 'message.updated',
      properties: {
        info: {
          id: 'assistant-message',
          sessionID: 'session-1',
          role: 'assistant',
          tokens: {
            input: 300000,
            output: 9000,
            reasoning: 0,
            cache: {
              read: 5000,
              write: 1000,
            },
          },
          cost: 1.23,
        },
      },
    } as EventMessageUpdated, state)

    const parts = convertEventToStreamParts({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'step-finish-1',
          sessionID: 'session-1',
          messageID: 'assistant-message',
          type: 'step-finish',
          reason: 'end_turn',
          cost: 0.12,
          tokens: {
            input: 120,
            output: 30,
            reasoning: 10,
            cache: {
              read: 40,
              write: 20,
            },
          },
        },
      },
    } as EventMessagePartUpdated, state)

    const metadataPart = parts.find((part) => part.type === 'message-metadata')
    expect(metadataPart && 'metadata' in metadataPart ? metadataPart.metadata.usage : undefined).toMatchObject({
      inputTokens: 180,
      outputTokens: 30,
      totalTokens: 210,
    })
  })

  it('uses message.updated totals for final finish metadata', () => {
    const state = createStreamState()
    state.stepStarted = true
    state.messageUsage = {
      inputTokens: 300000,
      outputTokens: 9000,
      reasoningTokens: 0,
      cachedInputTokens: 5000,
      cachedWriteTokens: 1000,
      totalCost: 1.23,
    }

    const finishParts = createFinishParts(
      state,
      { unified: 'stop', raw: 'end_turn' },
      'session-1',
      'opencode/big-pickle',
    )

    const metadataPart = finishParts.find((part) => part.type === 'message-metadata')
    expect(metadataPart && 'metadata' in metadataPart ? metadataPart.metadata.usage : undefined).toMatchObject({
      inputTokens: 306000,
      outputTokens: 9000,
      totalTokens: 315000,
    })
  })
})
