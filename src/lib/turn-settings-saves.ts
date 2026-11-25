import { chatKey, type ChatKey, type ChatRef } from './chat-ref'

/**
 * Model / mode / effort picks sent to the server (`/cc/dynamic-set`) that have
 * not been answered yet, per chat.
 *
 * An agent's chat runs on what the server has saved, not on what its tab sends
 * (see `chat-flow.ts`), so a pick followed at once by a send must reach the
 * server first. The send waits for these (`useChatRuntime`); a save that fails
 * does not hold the send back.
 */
const pending = new Map<ChatKey, Set<Promise<unknown>>>()

export function trackTurnSettingsSave<T>(chat: ChatRef, save: Promise<T>): Promise<T> {
  const key = chatKey(chat)
  let set = pending.get(key)
  if (!set) {
    set = new Set()
    pending.set(key, set)
  }
  set.add(save)
  const done = () => {
    const current = pending.get(key)
    current?.delete(save)
    if (current?.size === 0) pending.delete(key)
  }
  save.then(done, done)
  return save
}

/** Resolves once every save started so far for this chat has been answered (or failed). */
export async function turnSettingsSaved(chat: ChatRef): Promise<void> {
  const set = pending.get(chatKey(chat))
  if (!set || set.size === 0) return
  await Promise.allSettled([...set])
}
