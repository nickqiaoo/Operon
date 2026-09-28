import { create } from "zustand"
import type { BackgroundTaskSummary } from "@shared/background-tasks"

/**
 * Background sub-agents per conversation, mirrored from the live-status stream
 * (see lib/live-turn-events.ts). A chat absent from the map has none the server
 * knows of — which after a restart includes ones that did run and finished.
 */
export const useChatBackgroundTaskStore = create<{
  tasksByChat: ReadonlyMap<number, BackgroundTaskSummary[]>
  sync: (chats: Array<{ chatId: number; tasks: BackgroundTaskSummary[] }>) => void
  set: (chatId: number, tasks: BackgroundTaskSummary[]) => void
}>((set) => ({
  tasksByChat: new Map(),
  sync: (chats) =>
    set({ tasksByChat: new Map(chats.filter((chat) => chat.tasks.length > 0).map((chat) => [chat.chatId, chat.tasks])) }),
  set: (chatId, tasks) =>
    set((state) => {
      if (tasks.length === 0 && !state.tasksByChat.has(chatId)) return state
      const next = new Map(state.tasksByChat)
      if (tasks.length > 0) next.set(chatId, tasks)
      else next.delete(chatId)
      return { tasksByChat: next }
    }),
}))

/** The background task an `Agent` call spawned, if the chat reported one. */
export function useBackgroundTask(chatId: number | undefined, toolUseId: string | undefined): BackgroundTaskSummary | undefined {
  return useChatBackgroundTaskStore((state) =>
    chatId == null || !toolUseId
      ? undefined
      : state.tasksByChat.get(chatId)?.find((task) => task.toolUseId === toolUseId),
  )
}
