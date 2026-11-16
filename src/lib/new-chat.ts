import { getChatDraft } from "@/lib/chat-drafts"
import { providersQuery } from "@/lib/provider-queries"
import { queryClient } from "@/lib/query-client"
import { useEditorStore } from "@/stores/editor-store"
import { useNavigationStore } from "@/stores/navigation-store"
import { useProjectStore } from "@/stores/project-store"
import { useStreamingStore } from "@/stores/streaming-store"
import type { EditorTab } from "@/types/editor"

/**
 * The global "New chat" (sidebar entry, ⌘N): a blank chat in the current
 * workspace on the agent last started, whose composer then lets the user pick
 * another agent or move it to another workspace before the first send.
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

/** The last agent if it is still available, else the first available one. */
async function resolveProvider(): Promise<string> {
  const last = lastChatProvider()
  try {
    const providers = await queryClient.fetchQuery(providersQuery)
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

  // Pressing ⌘N twice must not stack empty tabs: reuse the blank one.
  const existing = useEditorStore.getState().tabs.find(isBlankDraft)
  if (existing) {
    useEditorStore.getState().setActiveTab(existing.id)
    return
  }
  const providerId = await resolveProvider()
  useEditorStore.getState().createChatTab(providerId, "Chat")
}

/** Move a not-yet-sent chat into another workspace and follow it there. */
export function moveDraftToWorkspace(tabId: string, workspaceId: number, projectId: number): void {
  useEditorStore.getState().moveTabToWorkspace(tabId, workspaceId)
  useProjectStore.getState().setActiveWorkspace(workspaceId, projectId)
}
