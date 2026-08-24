import type { RuntimeStreamPart } from '../../../types.js'
import type { FakeScript } from '../index.js'

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

/** Minimal text-only echo. Used as the fallback default. */
export const echoScript: FakeScript = async function* ({ session }) {
  const id = `txt-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'start-step', request: {}, warnings: [] } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield {
    type: 'text-delta',
    id,
    text: session.userMessage ? `Echo: ${session.userMessage}` : 'Hello from fake runtime.',
  } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield {
    type: 'finish-step',
    finishReason: 'stop',
    usage: ZERO_USAGE,
    response: {},
  } as RuntimeStreamPart
  yield {
    type: 'finish',
    finishReason: 'stop',
    totalUsage: ZERO_USAGE,
  } as RuntimeStreamPart
}

/** Two-chunk text reply, useful for streaming order assertions. */
export const splitTextScript: FakeScript = async function* ({ session }) {
  const id = `txt-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'Hello, ' } as RuntimeStreamPart
  yield { type: 'text-delta', id, text: 'world!' } as RuntimeStreamPart
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield {
    type: 'finish',
    finishReason: 'stop',
    totalUsage: ZERO_USAGE,
  } as RuntimeStreamPart
}

/**
 * Streams 5 deltas with a small delay between them. Lets tests observe streaming
 * state and exercise stop/abort timing.
 */
export const slowStreamScript: FakeScript = async function* ({ session, delay }) {
  const id = `txt-${session.turnIndex}`
  yield { type: 'start' } as RuntimeStreamPart
  yield { type: 'text-start', id } as RuntimeStreamPart
  for (let i = 1; i <= 5; i += 1) {
    await delay(50)
    yield { type: 'text-delta', id, text: `chunk-${i} ` } as RuntimeStreamPart
  }
  yield { type: 'text-end', id } as RuntimeStreamPart
  yield {
    type: 'finish',
    finishReason: 'stop',
    totalUsage: ZERO_USAGE,
  } as RuntimeStreamPart
}
