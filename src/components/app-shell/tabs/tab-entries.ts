import { useCallback, useMemo } from "react"
import { defineMessages, type MessageDescriptor } from "react-intl"
import {
  FolderTree,
  GitPullRequest,
  Globe,
  MessageSquarePlus,
  Plus,
  Terminal as TerminalIcon,
} from "lucide-react"
import { useProjectStore } from "@/stores/project-store"
import { useTabsStore } from "@/stores/tabs-store"
import { useAppShellStore } from "@/stores/app-shell-store"
import { browserScopeChatId } from "@/stores/browser-scope-store"
import { useEditorStore } from "@/stores/editor-store"
import {
  providerSupportsSideChat,
  useProviderCapabilityStore,
} from "@/stores/provider-capability-store"
import { openSideChat } from "@/lib/side-chat"
import type { PanelId, Tab, TabType } from "./types"

// Menu labels for the new-tab entries. Descriptors keep them statically
// extractable; the render sites (NewTabMenu / EmptyPanelState) translate them.
const M = defineMessages({
  filesLabel: { id: "tab.files.label", defaultMessage: "Files" },
  reviewLabel: { id: "tab.review.label", defaultMessage: "Review" },
  browserLabel: { id: "tab.browser.label", defaultMessage: "Browser" },
  terminalLabel: { id: "tab.terminal.label", defaultMessage: "Terminal" },
  sideChatLabel: { id: "tab.sideChat.label", defaultMessage: "Side chat" },
})

export interface MenuEntry {
  type: TabType
  label: MessageDescriptor
  icon: typeof Plus
  /** True if this type needs an open workspace to make sense. */
  requiresWorkspace: boolean
  /**
   * Builds the tab synchronously. Entries whose tab cannot be described up front
   * — a side chat has to create its chat row on the server first — leave this
   * unset and provide `open` instead.
   */
  build?: (ctx: { rootPath: string | null; openTabs: readonly Tab[] }) => Tab | null
  /** Opens the tab itself, for entries that need to talk to the server first. */
  open?: () => void | Promise<void>
  /** Hides the entry when the current context cannot support it. */
  isAvailable?: () => boolean
}

const counter = () => Math.random().toString(36).slice(2, 8)

/**
 * The conversation a side chat would branch from: the active editor tab, when it
 * is a persisted chat whose provider can fork and is not itself a side chat.
 */
function activeChatForSideChat(): { chatId: number; providerId?: string } | null {
  const editor = useEditorStore.getState()
  const tab = editor.tabs.find((t) => t.id === editor.activeTabId)
  if (tab == null || tab.type !== "chat" || tab.isSideChat) return null
  if (tab.chatId == null) return null
  if (!providerSupportsSideChat(tab.providerId)) return null
  return { chatId: tab.chatId, providerId: tab.providerId }
}

const nextTerminalTitle = (tabs: readonly Tab[]): string => {
  const usedNumbers = new Set<number>()
  for (const tab of tabs) {
    if (tab.payload.type !== "terminal") continue
    const match = /^Terminal (\d+)$/.exec(tab.title)
    if (match != null) usedNumbers.add(Number(match[1]))
  }

  let number = 1
  while (usedNumbers.has(number)) number += 1
  return `Terminal ${number}`
}

export const newTabEntries: MenuEntry[] = [
  {
    type: "workspace-browser",
    label: M.filesLabel,
    icon: FolderTree,
    requiresWorkspace: true,
    build: ({ rootPath }) => {
      if (rootPath == null) return null
      return {
        tabId: `workspace:${rootPath}:${counter()}`,
        title: rootPath.split(/[\\/]/).pop() ?? "Files",
        isClosable: true,
        payload: { type: "workspace-browser", rootPath, selectedPath: null },
      }
    },
  },
  {
    type: "review",
    label: M.reviewLabel,
    icon: GitPullRequest,
    requiresWorkspace: true,
    build: ({ rootPath }) => {
      if (rootPath == null) return null
      return {
        tabId: `review:${rootPath}:${counter()}`,
        title: "Review",
        isClosable: true,
        payload: { type: "review", rootPath },
      }
    },
  },
  {
    type: "browser",
    label: M.browserLabel,
    icon: Globe,
    requiresWorkspace: false,
    build: () => {
      const id = counter()
      return {
        tabId: `browser:${id}`,
        title: "New tab",
        isClosable: true,
        payload: {
          // Empty URL → the browser opens on the local-servers landing page.
          type: "browser",
          instanceId: id,
          url: "",
          // The browser panel is scoped to the conversation, so a page you open by
          // hand belongs to whichever chat is active — same as codex, where the
          // browser sidebar *is* that conversation's browser. This is also what lets
          // its agent see the page (`browser.user.openTabs()` → `claimTab`).
          // No active chat → ownerless: it stays yours and no agent can touch it.
          chatId: browserScopeChatId(),
        },
      }
    },
  },
  {
    type: "side-chat",
    label: M.sideChatLabel,
    icon: MessageSquarePlus,
    requiresWorkspace: false,
    // Only offered while a conversation is open on a provider that can fork it:
    // a side chat is a branch of something, not a blank chat.
    isAvailable: () => activeChatForSideChat() != null,
    open: async () => {
      const active = activeChatForSideChat()
      if (active == null) return
      await openSideChat(active.chatId, { providerId: active.providerId })
    },
  },
  {
    type: "terminal",
    label: M.terminalLabel,
    icon: TerminalIcon,
    requiresWorkspace: false,
    build: ({ rootPath, openTabs }) => {
      const id = counter()
      return {
        tabId: `terminal:${id}`,
        title: nextTerminalTitle(openTabs),
        isClosable: true,
        payload: {
          type: "terminal",
          terminalId: id,
          cwd: rootPath ?? "",
        },
      }
    },
  },
]

/** Visible items per panel (just affects ordering / hides irrelevant ones). */
const PANEL_ORDER: Record<PanelId, TabType[]> = {
  right: ["workspace-browser", "side-chat", "review", "browser", "terminal"],
  bottom: ["terminal", "browser", "workspace-browser", "review", "side-chat"],
}

/** Worktree path of the active workspace, read outside React. */
export function activeWorkspaceRoot(): string | null {
  const { projects, activeWorkspaceId } = useProjectStore.getState()
  for (const project of projects) {
    const workspace = project.workspaces.find((w) => w.id === activeWorkspaceId)
    if (workspace != null) return workspace.worktreePath
  }
  return null
}

/** Entries this context can actually offer, in the panel's own order. */
function availableEntries(panelId: PanelId): MenuEntry[] {
  const order = PANEL_ORDER[panelId]
  return newTabEntries
    .slice()
    // Context-dependent entries (side chat needs a forkable conversation open)
    // disappear rather than showing as permanently disabled.
    .filter((e) => e.isAvailable?.() !== false)
    // The in-app browser is an Electron <webview>; it has no web-build equivalent,
    // so drop it from the new-tab menu on the web target (Files/Review/Terminal
    // all go through the tunneled backend and stay available).
    .filter((e) => __APP_TARGET__ !== "web" || e.type !== "browser")
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
}

// Singleton tab types — at most one may exist across both panels. The menus
// disable the entry while one is open, and opening focuses the existing tab
// instead of duplicating. Only `review` qualifies: rendering a full diff is
// expensive, so a second one is disallowed. Browser tabs are not singletons —
// every page is its own `instanceId`/<webview>, which is what Browser Use has
// always relied on when opening several tabs for one conversation.
function findExistingTab(type: TabType): { panel: PanelId; tabId: string } | null {
  const { right, bottom } = useTabsStore.getState()
  const panels = [
    { id: "right" as const, tabs: right.tabs },
    { id: "bottom" as const, tabs: bottom.tabs },
  ]
  for (const { id, tabs } of panels) {
    const tab = tabs.find((t) => t.payload.type === type)
    if (tab != null) return { panel: id, tabId: tab.tabId }
  }
  return null
}

const openPanel = (panelId: PanelId) => {
  const shell = useAppShellStore.getState()
  if (panelId === "right") shell.setRightPanelOpen(true)
  else shell.setBottomPanelOpen(true)
}

/**
 * Opens one new-tab entry into `panelId`, from anywhere — the menus go through
 * the {@link useNewTab} hook, {@link toggleBottomPanelWithTerminal} calls it
 * directly (no React context there).
 */
export function openTabEntry(entry: MenuEntry, panelId: PanelId): void {
  // Never open a second instance of a singleton type — focus the existing tab
  // (in whichever panel) and open that panel instead.
  const existing = entry.type === "review" ? findExistingTab("review") : null
  if (existing != null) {
    useTabsStore.getState().activateTab(existing.panel, existing.tabId)
    openPanel(existing.panel)
    return
  }
  // Entries that must reach the server open themselves (and open the panel).
  if (entry.open != null) {
    void entry.open()
    return
  }
  const { right, bottom, openTab } = useTabsStore.getState()
  const tab = entry.build?.({
    rootPath: activeWorkspaceRoot(),
    openTabs: [...right.tabs, ...bottom.tabs],
  })
  if (tab == null) return
  openTab(panelId, tab)
  openPanel(panelId)
}

/**
 * ⌘J and the bottom-panel toggle button.
 *
 * Opening the panel while it is empty goes straight to a terminal instead of
 * the picker: a shell is the only thing anyone reaches for down there, so the
 * pick was one click standing between the user and a prompt (codex opens one
 * the same way). Reopening a panel that still holds tabs just reveals them.
 */
export function toggleBottomPanelWithTerminal(): void {
  const shell = useAppShellStore.getState()
  if (shell.bottomPanelOpen) {
    shell.setBottomPanelOpen(false)
    return
  }
  if (useTabsStore.getState().bottom.tabs.length === 0) {
    const terminal = newTabEntries.find((e) => e.type === "terminal")
    // openTabEntry opens the panel itself; the set below covers the other path.
    if (terminal != null) openTabEntry(terminal, "bottom")
  }
  shell.setBottomPanelOpen(true)
}

/**
 * Shared "new tab" logic for both the `+` dropdown (NewTabMenu) and the
 * empty-panel quick-pick cards (EmptyPanelState). Resolves the active
 * workspace root, orders the entries for the panel, and opens the panel when a
 * tab is created.
 */
export function useNewTab(panelId: PanelId) {
  const right = useTabsStore((s) => s.right)
  const bottom = useTabsStore((s) => s.bottom)

  // Drives the disabled state on the Review row; opening it while one exists
  // focuses that tab instead (see openTabEntry).
  const existingReview = useMemo(
    () =>
      [...right.tabs, ...bottom.tabs].some((t) => t.payload.type === "review"),
    [right.tabs, bottom.tabs]
  )

  const activeWorkspaceId = useProjectStore((s) => s.activeWorkspaceId)
  const projects = useProjectStore((s) => s.projects)
  const rootPath = useMemo(() => {
    for (const project of projects) {
      const workspace = project.workspaces.find(
        (w) => w.id === activeWorkspaceId
      )
      if (workspace != null) return workspace.worktreePath
    }
    return null
  }, [projects, activeWorkspaceId])

  // Subscribed, not just read inside the memo below: the side chat entry appears
  // and disappears as the user switches conversations, so the menu has to
  // re-derive when that changes.
  const sideChatSource = useEditorStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.type === "chat" && !tab.isSideChat ? (tab.chatId ?? null) : null
  })
  const sideChatProviders = useProviderCapabilityStore((s) => s.byProvider)

  const ordered = useMemo(
    () => availableEntries(panelId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panelId, sideChatSource, sideChatProviders]
  )

  const openEntry = useCallback(
    (entry: MenuEntry) => openTabEntry(entry, panelId),
    [panelId]
  )

  return {
    rootPath,
    ordered,
    openEntry,
    reviewExists: existingReview,
  }
}
