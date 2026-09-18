import { randomUUID } from 'node:crypto'
import { getSessionManager } from '../ai.js'
import { runAgentTurn } from './agent-turn.js'
import { extractAssistantText } from './message-utils.js'

export interface OneShotPromptOptions {
  prompt: string
  /** Working directory for the throwaway session (the repo being summarized). */
  cwd: string
  providerId: string
  modelId?: string
  signal?: AbortSignal
}

/**
 * Run a single prompt through a throwaway session and return the assistant's
 * text. Used by the small "ask the model to write this one string" helpers
 * (commit message, PR summary) — they share the chat turn core so provider
 * setup, tool gating and message assembly stay in one place.
 *
 * Callers are expected to forbid tool calls in the prompt itself; the assembled
 * message is then a single text block.
 */
export async function runOneShotPrompt(options: OneShotPromptOptions): Promise<string> {
  const manager = getSessionManager()
  const session = await manager.createStandaloneSession(options.providerId, {
    cwd: options.cwd,
    providerId: options.providerId,
    modelId: options.modelId,
  })

  try {
    const { preparedParts, done } = runAgentTurn(session, {
      requestId: randomUUID(),
      messages: [{ role: 'user', content: options.prompt }],
      signal: options.signal ?? new AbortController().signal,
      assistantMessageId: randomUUID(),
      originalMessages: [],
    })
    void preparedParts.cancel() // no live consumer here; only `done` is needed

    const { message } = await done
    return extractAssistantText(message)
  } finally {
    await session.dispose().catch(() => {})
  }
}
