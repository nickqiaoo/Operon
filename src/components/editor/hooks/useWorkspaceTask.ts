import { useTaskByChat, useTaskByWorkspace } from "@/lib/task-queries"
import { useEditorStore } from "@/stores/editor-store"
import type { Task } from "@/types/task"

/**
 * The task the open conversation or its workspace was dispatched for, or null
 * for a workspace and chat the user made by hand. Lets the editor offer a way
 * back to the task page.
 *
 * The chat is asked first: a task in shared mode runs in a workspace it does
 * not own (the project's main one), so only its conversation knows the task.
 * Only identity is read from the result (`#number`, title) — never live status.
 */
export function useWorkspaceTask(): { task: Task | null; projectId: number | null } {
  const workspaceId = useEditorStore((s) => s.currentWorkspaceId)
  const projectId = useEditorStore((s) => s.currentProjectId)
  const chatId = useEditorStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.type === "chat" && tab.chatId != null ? tab.chatId : null
  })
  const byChat = useTaskByChat(chatId)
  const byWorkspace = useTaskByWorkspace(workspaceId)
  return { task: byChat.data ?? byWorkspace.data ?? null, projectId: (byChat.data?.projectId ?? projectId) }
}
