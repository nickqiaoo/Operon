import { useEffect } from "react"
import { api } from "@/lib/api"
import { useEditorStore } from "@/stores/editor-store"

/** Workspaces whose agent sessions were already opened this app session. */
const opened = new Set<number>()

/**
 * Open the agent sessions the server started in a workspace as tabs, the first
 * time the user enters it.
 *
 * A task dispatched from the board runs its agent in a worktree of its own,
 * started by the server, so no tab was ever opened for it there: entering the
 * worktree showed an empty editor even while the agent was working (or blocked
 * on an approval). Tabs don't survive a reload either, so the same applies
 * after one. Once per workspace per app session, so a tab the user closes
 * stays closed.
 */
export function useOpenWorkspaceSessions(workspaceId: number | null): void {
  useEffect(() => {
    if (workspaceId == null || opened.has(workspaceId)) return
    opened.add(workspaceId)
    void api
      .workspaceSessions(workspaceId)
      .then(({ sessions }) => {
        const store = useEditorStore.getState()
        // The user moved on before the answer came back; try again on the next visit.
        if (store.currentWorkspaceId !== workspaceId) {
          opened.delete(workspaceId)
          return
        }
        const hadTabs = store.tabs.some((tab) => !tab.isSideChat)
        sessions.forEach((session, index) => {
          store.openChatTab(
            `chat:${session.chatId}`,
            session.title?.trim() || "Chat",
            hadTabs || index > 0 ? { background: true } : undefined,
            session.providerId ?? undefined,
          )
        })
      })
      .catch((error) => {
        opened.delete(workspaceId)
        console.warn("[workspace-sessions] load failed:", error)
      })
  }, [workspaceId])
}
