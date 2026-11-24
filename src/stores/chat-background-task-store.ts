import { create } from "zustand"
import type { BackgroundTaskSummary } from "@shared/background-tasks"
import { chatKey, replaceNodeEntries, type ChatKey, type ChatRef, type NodeKey } from "@/lib/chat-ref"

/**
 * Each conversation's Claude Code task list, mirrored from the live-status stream
 * (see lib/live-turn-events.ts). A chat absent from the map has none the server
 * knows of — which after a restart includes ones that did run and finished.
 * Keyed by `ChatKey`: each machine whose stream is open reports its own chats.
 */
export const useChatBackgroundTaskStore = create<{
  tasksByChat: ReadonlyMap<ChatKey, BackgroundTaskSummary[]>
  /** One machine's full list (its stream's `sync` frame). */
  sync: (node: NodeKey, chats: Array<{ chatId: number; tasks: BackgroundTaskSummary[] }>) => void
  set: (chat: ChatRef, tasks: BackgroundTaskSummary[]) => void
}>((set) => ({
  tasksByChat: new Map(),
  sync: (node, chats) =>
    set((state) => ({
      tasksByChat: replaceNodeEntries(
        state.tasksByChat,
        node,
        chats.filter((chat) => chat.tasks.length > 0).map((chat): [number, BackgroundTaskSummary[]] => [chat.chatId, chat.tasks]),
      ),
    })),
  set: (chat, tasks) =>
    set((state) => {
      const key = chatKey(chat)
      if (tasks.length === 0 && !state.tasksByChat.has(key)) return state
      const next = new Map(state.tasksByChat)
      if (tasks.length > 0) next.set(key, tasks)
      else next.delete(key)
      return { tasksByChat: next }
    }),
}))

const NO_TASKS: BackgroundTaskSummary[] = []

/** A chat's whole task list, as the session reported it (empty when it has none). */
export function useChatTasks(chat: ChatRef | undefined): BackgroundTaskSummary[] {
  const key = chat ? chatKey(chat) : undefined
  return useChatBackgroundTaskStore((state) => (key == null ? NO_TASKS : state.tasksByChat.get(key) ?? NO_TASKS))
}

/**
 * The background task an `Agent` call spawned, if the chat reported one. A
 * foreground agent's steps stream inside the turn, so its entry is not one.
 */
export function useBackgroundTask(chat: ChatRef | undefined, toolUseId: string | undefined): BackgroundTaskSummary | undefined {
  const key = chat ? chatKey(chat) : undefined
  return useChatBackgroundTaskStore((state) =>
    key == null || !toolUseId
      ? undefined
      : state.tasksByChat.get(key)?.find((task) => task.toolUseId === toolUseId && task.backgrounded),
  )
}
