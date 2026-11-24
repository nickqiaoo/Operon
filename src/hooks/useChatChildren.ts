import { useMemo } from 'react'
import { buildChatChildren, type ChatChild } from '@/lib/chat-children'
import { activateWorkspace } from '@/lib/workspace-nav'
import { useChatPendingInputStore } from '@/stores/chat-pending-input-store'
import { useEditorStore } from '@/stores/editor-store'
import { isOnNode, useExternalAgentsStore } from '@/stores/external-agents-store'
import { chatTabId, nodeEntries, nodeKeyOf, type ChatRef } from '@/lib/chat-ref'
import { useProjectStore } from '@/stores/project-store'

/**
 * The agents a chat started, live (see `buildChatChildren`): external agents it
 * dispatched, and — when it is a board task's session — the sub-tasks handed out
 * from it. The stores are pushed; the sub-tasks come with the project tree.
 */
export function useChatChildren(chat: ChatRef | undefined): ChatChild[] {
  const agents = useExternalAgentsStore((s) => s.agents)
  const pendingByChat = useChatPendingInputStore((s) => s.pendingByChat)
  const projects = useProjectStore((s) => s.projects)
  const chatId = chat?.chatId
  const nodeId = chat?.nodeId
  return useMemo(() => {
    if (chatId == null) return []
    // A chat's children are reported by the machine it lives on, with chat ids
    // of that machine. The project tree (board sub-tasks) is this machine's.
    const children = buildChatChildren({
      chatId,
      externalAgents: [...agents.values()].filter((agent) => isOnNode(agent, nodeId)),
      pendingByChat: nodeEntries(pendingByChat, nodeKeyOf(nodeId)),
      taskChildren: nodeId ? [] : projects.flatMap((p) => p.taskChildren ?? []),
    })
    return nodeId ? children.map((child) => ({ ...child, nodeId })) : children
  }, [chatId, nodeId, agents, pendingByChat, projects])
}

/** Sessions of board sub-tasks, by chat id: they show under their parent's session, not as rows of their own. */
export function useTaskChildChatIds(): ReadonlySet<number> {
  const projects = useProjectStore((s) => s.projects)
  return useMemo(() => new Set(projects.flatMap((p) => (p.taskChildren ?? []).map((c) => c.chatId))), [projects])
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
  child: Pick<ChatChild, 'childChatId' | 'nodeId' | 'title' | 'providerId' | 'modelId' | 'modeId' | 'workspaceId'>,
): Promise<void> {
  const editor = useEditorStore.getState()
  const ref: ChatRef = child.nodeId ? { nodeId: child.nodeId, chatId: child.childChatId } : { chatId: child.childChatId }
  // Already open somewhere: that tab, in whatever workspace holds it.
  const existing = editor.findChatTab(ref)
  // Its own workspace, on its own machine: a remote agent's workspace sits under
  // that machine in the tree, and switching there points the whole workbench at it.
  const workspaceId = existing ? existing.workspaceId : child.workspaceId
  const nodeId = existing ? existing.nodeId : child.nodeId
  const here = workspaceId === editor.currentWorkspaceId && (nodeId ?? null) === editor.currentNodeId
  if (workspaceId != null && !here) {
    await activateWorkspace(workspaceId, nodeId)
  }
  useEditorStore.getState().openChatTab(
    existing?.tabId ?? chatTabId(ref),
    `Agent: ${child.title}`,
    { modelId: child.modelId ?? 'default', ...(child.modeId ? { modeId: child.modeId } : {}) },
    child.providerId,
    true,
  )
}
