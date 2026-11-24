import { getChatDraft } from "@/lib/chat-drafts"
import { providersQueryFor } from "@/lib/provider-queries"
import { queryClient } from "@/lib/query-client"
import { useEditorStore } from "@/stores/editor-store"
import { useNavigationStore } from "@/stores/navigation-store"
import { projectsOn, useProjectStore } from "@/stores/project-store"
import { useStreamingStore } from "@/stores/streaming-store"
import { mainWorkspaceOf } from "@/lib/workspace-actions"
import type { EditorTab } from "@/types/editor"

/**
 * The global "New chat" (sidebar entry, ⌘N): a blank chat on the current
 * project's own checkout, on the agent last started, whose composer then lets
 * the user pick another agent, project or a new worktree before the first send.
 * A worktree belongs to the chat that asked for it, so the next chat does not
 * land in it just because it was the last one open.
 */

const LAST_PROVIDER_KEY = "operon.chat.last-provider:v1"
const FALLBACK_PROVIDER_ID = "claude-code"

export function rememberChatProvider(providerId: string): void {
  try {
    localStorage.setItem(LAST_PROVIDER_KEY, providerId)
  } catch {
    // Storage can be unavailable; the fallback order covers it.
  }
}

function lastChatProvider(): string | null {
  try {
    return localStorage.getItem(LAST_PROVIDER_KEY)
  } catch {
    return null
  }
}

/**
 * The last agent if it is still available, else the first available one — on
 * the machine of the current workspace, where the chat will run.
 */
async function resolveProvider(): Promise<string> {
  const last = lastChatProvider()
  try {
    const nodeId = useProjectStore.getState().activeNodeId ?? undefined
    const providers = await queryClient.fetchQuery(providersQueryFor(nodeId))
    const available = providers.filter((p) => p.available)
    return available.find((p) => p.id === last)?.id ?? available[0]?.id ?? last ?? FALLBACK_PROVIDER_ID
  } catch {
    return last ?? FALLBACK_PROVIDER_ID
  }
}

/**
 * A chat that has not been sent and carries nothing: no persisted id, no text,
 * no prefilled prompt. Only these show the agent / workspace pickers.
 */
export function isDraftChatTab(tab: EditorTab | undefined): boolean {
  return (
    tab !== undefined &&
    tab.type === "chat" &&
    tab.chatId === undefined &&
    tab.isSubAgent !== true &&
    tab.isSideChat !== true &&
    tab.options?.autoRun !== true
  )
}

function isBlankDraft(tab: EditorTab): boolean {
  return (
    isDraftChatTab(tab) &&
    !tab.options?.input &&
    !tab.options?.inputAttachment &&
    getChatDraft(tab.id).trim() === "" &&
    !useStreamingStore.getState().streamingTabIds.has(tab.id)
  )
}

export async function startNewChat(): Promise<void> {
  const navigation = useNavigationStore.getState()
  for (const page of navigation.pages) navigation.closePage(page.kind)
  navigation.showWorkbench()

  // Back to the project's main checkout (switching is synchronous, so the tab
  // below opens there). Stays on the current workspace's machine: project and
  // workspace ids repeat across machines.
  const projects = useProjectStore.getState()
  const nodeId = projects.activeNodeId
  const tree = projectsOn(projects, nodeId)
  const project =
    tree.find((p) => p.id === projects.activeProjectId) ??
    tree.find((p) => p.workspaces.some((w) => w.id === projects.activeWorkspaceId))
  const main = project ? mainWorkspaceOf(project) : undefined
  if (project && main && main.id !== projects.activeWorkspaceId) projects.setActiveWorkspace(main.id, project.id, nodeId)

  await openBlankChat()
}

/**
 * A blank chat in one specific workspace (the pen on its sidebar row): how the
 * first chat of a workspace is started, since the tab strip only offers "+"
 * once it has tabs.
 */
export async function startNewChatInWorkspace(workspaceId: number, projectId: number, nodeId?: string): Promise<void> {
  const navigation = useNavigationStore.getState()
  for (const page of navigation.pages) navigation.closePage(page.kind)
  navigation.showWorkbench()
  const state = useProjectStore.getState()
  if (state.activeWorkspaceId !== workspaceId || state.activeNodeId !== (nodeId ?? null)) {
    state.setActiveWorkspace(workspaceId, projectId, nodeId)
  }
  await openBlankChat()
}

async function openBlankChat(): Promise<void> {
  // Pressing ⌘N twice must not stack empty tabs: reuse the blank one.
  const existing = useEditorStore.getState().tabs.find(isBlankDraft)
  if (existing) {
    useEditorStore.getState().setActiveTab(existing.id)
    return
  }
  const providerId = await resolveProvider()
  useEditorStore.getState().createChatTab(providerId, "Chat")
}

/**
 * Move a not-yet-sent chat into another workspace and follow it there.
 * `nodeId`: the machine of both workspaces (a draft stays on its machine).
 */
export function moveDraftToWorkspace(tabId: string, workspaceId: number, projectId: number, nodeId?: string): void {
  useEditorStore.getState().moveTabToWorkspace(tabId, workspaceId)
  useProjectStore.getState().setActiveWorkspace(workspaceId, projectId, nodeId)
}
