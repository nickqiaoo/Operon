import { create } from "zustand"
import { getChatDraft, moveChatDraft } from "@/lib/chat-drafts"
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
 * The workspace whose new chat is on its way: picking the agent may first ask
 * another machine which it has. Until the tab opens, the workbench shows that
 * instead of its empty state.
 */
export const useOpeningChatStore = create<{ pending: boolean; workspaceId: number | null; nodeId: string | null }>(() => ({
  pending: false,
  workspaceId: null,
  nodeId: null,
}))

/** Mark `workspaceId` (on `nodeId`) as opening a chat; the returned call ends it, unless another began since. */
function markOpening(workspaceId: number | null, nodeId: string | null): () => void {
  useOpeningChatStore.setState({ pending: true, workspaceId, nodeId })
  return () => {
    const opening = useOpeningChatStore.getState()
    if (opening.workspaceId === workspaceId && opening.nodeId === nodeId) {
      useOpeningChatStore.setState({ pending: false, workspaceId: null, nodeId: null })
    }
  }
}

/**
 * `preferred` (else the last agent) if it is still available, else the first
 * available one — on the machine of the current workspace, where the chat will
 * run. A list read before is used as it is: it rarely changes, and waiting on
 * another machine for it is what kept a new chat from opening.
 */
async function resolveProvider(preferred?: string): Promise<string> {
  const last = preferred ?? lastChatProvider()
  try {
    const nodeId = useProjectStore.getState().activeNodeId ?? undefined
    const providers = await queryClient.ensureQueryData(providersQueryFor(nodeId))
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
export async function startNewChatInWorkspace(workspaceId: number, projectId: number, nodeId?: string): Promise<string> {
  const navigation = useNavigationStore.getState()
  for (const page of navigation.pages) navigation.closePage(page.kind)
  navigation.showWorkbench()
  const state = useProjectStore.getState()
  if (state.activeWorkspaceId !== workspaceId || state.activeNodeId !== (nodeId ?? null)) {
    state.setActiveWorkspace(workspaceId, projectId, nodeId)
  }
  return openBlankChat()
}

async function openBlankChat(preferredProvider?: string): Promise<string> {
  // Pressing ⌘N twice must not stack empty tabs: reuse the blank one.
  const existing = useEditorStore.getState().tabs.find(isBlankDraft)
  if (existing) {
    useEditorStore.getState().setActiveTab(existing.id)
    return existing.id
  }
  const { activeWorkspaceId, activeNodeId } = useProjectStore.getState()
  const done = markOpening(activeWorkspaceId, activeNodeId)
  try {
    const providerId = await resolveProvider(preferredProvider)
    return useEditorStore.getState().createChatTab(providerId, "Chat")
  } finally {
    done()
  }
}

/**
 * Move a not-yet-sent chat into another workspace and follow it there.
 * `nodeId`: the machine of both workspaces (a draft stays on its machine).
 */
export function moveDraftToWorkspace(tabId: string, workspaceId: number, projectId: number, nodeId?: string): void {
  useEditorStore.getState().moveTabToWorkspace(tabId, workspaceId)
  useProjectStore.getState().setActiveWorkspace(workspaceId, projectId, nodeId)
}

/**
 * Take a not-yet-sent chat to a workspace on another machine. A tab is bound to
 * its machine, so this opens a new draft there with what was typed (text, files,
 * skills) and the same agent when that machine has it, and closes this one.
 */
export async function moveDraftToMachine(tabId: string, workspaceId: number, projectId: number, nodeId: string | null): Promise<void> {
  const editor = useEditorStore.getState()
  const tab = editor.tabs.find((t) => t.id === tabId)
  if (!tab) return
  // Kept aside while the old tab closes (closing drops its draft and files).
  const held = `${tabId}:moving`
  moveChatDraft(tabId, held)
  editor.closeTab(tabId)
  useProjectStore.getState().setActiveWorkspace(workspaceId, projectId, nodeId)
  // A blank draft already there would show nothing of what was typed: its
  // composer read its own (empty) draft when it mounted.
  const blank = useEditorStore.getState().tabs.find(isBlankDraft)
  if (blank) useEditorStore.getState().closeTab(blank.id)
  const done = markOpening(workspaceId, nodeId)
  try {
    const providerId = await resolveProvider(tab.providerId)
    // Same tick as the tab: its composer reads the draft when it mounts.
    const nextId = useEditorStore.getState().createChatTab(providerId, "Chat")
    moveChatDraft(held, nextId)
  } finally {
    done()
  }
}
