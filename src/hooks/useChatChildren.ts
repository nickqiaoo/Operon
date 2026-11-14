import { useMemo } from 'react'
import { buildChatChildren, type ChatChild } from '@/lib/chat-children'
import { activateWorkspace } from '@/lib/workspace-nav'
import { useChatPendingInputStore } from '@/stores/chat-pending-input-store'
import { useEditorStore } from '@/stores/editor-store'
import { useExternalAgentsStore } from '@/stores/external-agents-store'
import { useProjectStore } from '@/stores/project-store'

/** The external agents a chat started, live (see `buildChatChildren`). Both stores are pushed. */
export function useChatChildren(chatId: number | undefined): ChatChild[] {
  const agents = useExternalAgentsStore((s) => s.agents)
  const pendingByChat = useChatPendingInputStore((s) => s.pendingByChat)
  return useMemo(
    () => (chatId == null ? [] : buildChatChildren({ chatId, externalAgents: agents.values(), pendingByChat })),
    [chatId, agents, pendingByChat],
  )
}

/**
 * The name of the workspace an agent works in, when it is not the one on screen:
 * its changes are on that branch, not in the worktree the parent shows.
 */
export function useOtherWorkspaceName(workspaceId: number | undefined): string | undefined {
  const currentWorkspaceId = useEditorStore((s) => s.currentWorkspaceId)
  // From the store, so the name appears once a reload brings a new workspace in.
  return useProjectStore((s) => {
    if (workspaceId == null || workspaceId === currentWorkspaceId) return undefined
    for (const project of s.projects) {
      const workspace = project.workspaces.find((w) => w.id === workspaceId)
      if (workspace) return workspace.name
    }
    return undefined
  })
}

/**
 * Bring an external agent's conversation up. Agents no longer open a tab when they
 * start; this is how one gets opened (or focused, when it already is).
 *
 * In its own workspace's editor, like any conversation opened from elsewhere: one
 * working in a workspace of its own goes there, rather than into the parent's tabs
 * where the git panel and files would be another worktree's.
 */
export async function openChildChat(
  child: Pick<ChatChild, 'childChatId' | 'title' | 'providerId' | 'modelId' | 'modeId' | 'workspaceId'>,
): Promise<void> {
  const editor = useEditorStore.getState()
  // Already open somewhere: that tab, in whatever workspace holds it.
  const existing = editor.findChatTab(child.childChatId)
  const workspaceId = existing ? existing.workspaceId : child.workspaceId
  if (workspaceId != null && workspaceId !== editor.currentWorkspaceId) {
    await activateWorkspace(workspaceId)
  }
  useEditorStore.getState().openChatTab(
    existing?.tabId ?? `chat:${child.childChatId}`,
    `Agent: ${child.title}`,
    { modelId: child.modelId ?? 'default', ...(child.modeId ? { modeId: child.modeId } : {}) },
    child.providerId,
    true,
  )
}
