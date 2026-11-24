import type { ReactNode } from "react"
import { ChatApiProvider } from "@/lib/chat-api-context"
import { useEditorStore } from "@/stores/editor-store"

/**
 * Points the workbench at the machine of the current workspace: the file
 * browser, git, Review, terminals and the workspace header all call
 * `useChatApi()`, so in another machine's workspace they work on that
 * machine's worktree. Chat tabs nest their own provider (the tab's machine,
 * which is the same machine for every tab of a workspace).
 *
 * Only the workbench is wrapped. Board, Inbox and Channels show this machine
 * whatever workspace is current.
 */
export function WorkspaceApiProvider({ children }: { children: ReactNode }) {
  const nodeId = useEditorStore((s) => s.currentNodeId ?? undefined)
  return <ChatApiProvider nodeId={nodeId}>{children}</ChatApiProvider>
}
