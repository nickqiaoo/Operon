import type { ModelMessage } from 'ai'
import type { AgentInput } from '../types.js'

/**
 * A turn's input as the one-message prompt the providers' converters take.
 * Every provider only ever reads the latest user message — the agent keeps the
 * history — so this is the whole conversion.
 */
export function toUserMessages(input: AgentInput): ModelMessage[] {
  return [{ role: 'user', content: input }]
}

/** The text of a turn's input, parts joined — for slash commands and goal objectives. */
export function inputText(input: AgentInput): string {
  if (typeof input === 'string') return input
  return input.map((part) => (part.type === 'text' ? part.text : '')).join('')
}
