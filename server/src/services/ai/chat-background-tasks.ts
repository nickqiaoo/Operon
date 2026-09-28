// Background sub-agents per conversation, as the runtime last reported them.
//
// A Claude Code `Agent` launched with `run_in_background` returns at once and
// keeps working after the turn that started it has ended. Its card needs to know
// it is still running, what it is doing and when it finishes — none of which
// reaches the chat's message stream. The runtime reports the whole list on every
// change (`RuntimeBackgroundEvent` `tasks`); this keeps the latest per chat and
// fans it out to the live-status stream.
//
// Process-local, like the CLI processes whose agents it mirrors: a session that is
// torn down reports an empty list, and a restart starts from nothing.

import type { BackgroundTaskSummary } from '../../../../shared/background-tasks.js'

export type { BackgroundTaskSummary }

export interface BackgroundTasksChange {
  chatId: number
  tasks: BackgroundTaskSummary[]
}

const tasksByChat = new Map<number, BackgroundTaskSummary[]>()
const listeners = new Set<(change: BackgroundTasksChange) => void>()

export function setChatBackgroundTasks(chatId: number, tasks: BackgroundTaskSummary[]): void {
  if (tasks.length === 0 && !tasksByChat.has(chatId)) return
  if (tasks.length > 0) tasksByChat.set(chatId, tasks)
  else tasksByChat.delete(chatId)
  for (const listener of listeners) {
    try {
      listener({ chatId, tasks })
    } catch (err) {
      console.error('[BackgroundTasks] subscriber failed:', err)
    }
  }
}

export function subscribeBackgroundTasks(listener: (change: BackgroundTasksChange) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Every chat with background tasks, for a stream's connect-time snapshot. */
export function listChatBackgroundTasks(): BackgroundTasksChange[] {
  return [...tasksByChat.entries()].map(([chatId, tasks]) => ({ chatId, tasks }))
}
