import type { AssistantMessage } from './types'

/** What the user said next after the message at `index`, if they have said anything since. */
export function nextUserText(messages: readonly AssistantMessage[], index: number): string | undefined {
  for (let i = index + 1; i < messages.length; i++) {
    if (messages[i].role === 'user') return messages[i].text
  }
  return undefined
}

/** One task entry in the thread, at its latest reference (card or reply link). */
export function latestActivityMessages(messages: readonly AssistantMessage[]): Map<string, string> {
  const latest = new Map<string, string>()
  for (const message of messages) {
    if (message.activityId) latest.set(message.activityId, message.id)
  }
  return latest
}
