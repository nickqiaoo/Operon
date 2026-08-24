import { useCallback, useMemo } from "react"
import { defineMessages, type MessageDescriptor } from "react-intl"
import {
  FolderTree,
  GitPullRequest,
  Globe,
  Plus,
  Terminal as TerminalIcon,
} from "lucide-react"
import { useProjectStore } from "@/stores/project-store"
import { useTabsStore } from "@/stores/tabs-store"
import { useAppShellStore } from "@/stores/app-shell-store"
import { browserScopeChatId } from "@/stores/browser-scope-store"
import type { PanelId, Tab, TabType } from "./types"

// Menu/card labels for the new-tab entries. Descriptors keep them statically
// extractable; the render sites (NewTabMenu / EmptyPanelState) translate them.
const M = defineMessages({
  filesLabel: { id: "tab.files.label", defaultMessage: "Files" },
  filesDesc: { id: "tab.files.desc", defaultMessage: "Browse project files" },
  reviewLabel: { id: "tab.review.label", defaultMessage: "Review" },
  reviewDesc: { id: "tab.review.desc", defaultMessage: "View code changes" },
  browserLabel: { id: "tab.browser.label", defaultMessage: "Browser" },
  browserDesc: { id: "tab.browser.desc", defaultMessage: "Open a website" },
  terminalLabel: { id: "tab.terminal.label", defaultMessage: "Terminal" },
  terminalDesc: { id: "tab.terminal.desc", defaultMessage: "Start an interactive shell" },
})

export interface MenuEntry {
  type: TabType
  label: MessageDescriptor
  /** Short helper text shown under the label in the empty-panel cards. */
  description: MessageDescriptor
  icon: typeof Plus
  /** True if this type needs an open workspace to make sense. */
  requiresWorkspace: boolean
  build: (ctx: { rootPath: string | null; openTabs: readonly Tab[] }) => Tab | null
}

const counter = () => Math.random().toString(36).slice(2, 8)

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
    description: M.filesDesc,
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
    description: M.reviewDesc,
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
    description: M.browserDesc,
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
    type: "terminal",
    label: M.terminalLabel,
    description: M.terminalDesc,
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
  right: ["workspace-browser", "review", "browser", "terminal"],
  bottom: ["terminal", "browser", "workspace-browser", "review"],
}

/**
 * Shared "new tab" logic for both the `+` dropdown (NewTabMenu) and the
 * empty-panel quick-pick cards (EmptyPanelState). Resolves the active
 * workspace root, orders the entries for the panel, and opens the panel when a
 * tab is created.
 */
export function useNewTab(panelId: PanelId) {
  const openTab = useTabsStore((s) => s.openTab)
  const activateTab = useTabsStore((s) => s.activateTab)
  const right = useTabsStore((s) => s.right)
  const bottom = useTabsStore((s) => s.bottom)
  const setRightOpen = useAppShellStore((s) => s.setRightPanelOpen)
  const setBottomOpen = useAppShellStore((s) => s.setBottomPanelOpen)

  // Singleton tab types — at most one may exist across both panels. The menus
  // disable the entry while one is open, and openEntry focuses the existing tab
  // instead of duplicating. Only `review` qualifies: rendering a full diff is
  // expensive, so a second one is disallowed. Browser tabs are not singletons —
  // every page is its own `instanceId`/<webview>, which is what Browser Use has
  // always relied on when opening several tabs for one conversation.
  const findExisting = useCallback(
    (type: TabType): { panel: PanelId; tabId: string } | null => {
      const panels: { id: PanelId; tabs: Tab[] }[] = [
        { id: "right", tabs: right.tabs },
        { id: "bottom", tabs: bottom.tabs },
      ]
      for (const { id, tabs } of panels) {
        const tab = tabs.find((t) => t.payload.type === type)
        if (tab != null) return { panel: id, tabId: tab.tabId }
      }
      return null
    },
    [right.tabs, bottom.tabs]
  )
  const existingReview = useMemo(() => findExisting("review"), [findExisting])

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

  const ordered = useMemo(() => {
    const order = PANEL_ORDER[panelId]
    return newTabEntries
      .slice()
      // The in-app browser is an Electron <webview>; it has no web-build equivalent,
      // so drop it from the new-tab menu on the web target (Files/Review/Terminal
      // all go through the tunneled backend and stay available).
      .filter((e) => __APP_TARGET__ !== "web" || e.type !== "browser")
      .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
  }, [panelId])

  const openEntry = useCallback(
    (entry: MenuEntry) => {
      // Never open a second instance of a singleton type — focus the existing
      // tab (in whichever panel) and open that panel instead.
      const existing = entry.type === "review" ? existingReview : null
      if (existing != null) {
        activateTab(existing.panel, existing.tabId)
        if (existing.panel === "right") setRightOpen(true)
        else setBottomOpen(true)
        return
      }
      const tab = entry.build({ rootPath, openTabs: [...right.tabs, ...bottom.tabs] })
      if (tab == null) return
      openTab(panelId, tab)
      if (panelId === "right") setRightOpen(true)
      else setBottomOpen(true)
    },
    [
      openTab,
      activateTab,
      existingReview,
      panelId,
      rootPath,
      right.tabs,
      bottom.tabs,
      setRightOpen,
      setBottomOpen,
    ]
  )

  return {
    rootPath,
    ordered,
    openEntry,
    reviewExists: existingReview != null,
  }
}
