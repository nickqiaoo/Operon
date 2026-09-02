import { defineMessages, type MessageDescriptor } from "react-intl"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useTabsStore } from "@/stores/tabs-store"
import {
  activeWorkspaceRoot,
  newTabEntries,
  openTabEntry,
  toggleBottomPanelWithTerminal,
} from "@/components/app-shell/tabs/tab-entries"
import type { PanelId, TabType } from "@/components/app-shell/tabs/types"

/**
 * Every keyboard-bindable action, in one table.
 *
 * Modelled on codex's command registry: a command carries its own title,
 * description and default bindings, and both the settings page and the shortcut
 * dispatcher are just renderings of this list — so adding an action is one entry
 * here, never a new keydown handler.
 *
 * The default keys are codex's own values wherever we have the same action, so
 * muscle memory carries over. Panel toggles keep the bindings this app already
 * shipped with (⌘\ / ⌘J) rather than adopting codex's, which were different.
 */

const M = defineMessages({
  openFilesTitle: { id: "shortcut.openFiles.title", defaultMessage: "Files" },
  openFilesDesc: {
    id: "shortcut.openFiles.desc",
    defaultMessage: "Open the file browser in the right panel",
  },
  openReviewTitle: { id: "shortcut.openReview.title", defaultMessage: "Review" },
  openReviewDesc: {
    id: "shortcut.openReview.desc",
    defaultMessage: "Open the review tab for the current workspace",
  },
  openBrowserTitle: { id: "shortcut.openBrowser.title", defaultMessage: "Browser" },
  openBrowserDesc: {
    id: "shortcut.openBrowser.desc",
    defaultMessage: "Open a new in-app browser tab",
  },
  openTerminalTitle: { id: "shortcut.openTerminal.title", defaultMessage: "Terminal" },
  openTerminalDesc: {
    id: "shortcut.openTerminal.desc",
    defaultMessage: "Open a terminal in the bottom panel",
  },
  openSideChatTitle: { id: "shortcut.openSideChat.title", defaultMessage: "Side chat" },
  openSideChatDesc: {
    id: "shortcut.openSideChat.desc",
    defaultMessage: "Ask something without disturbing the main chat",
  },
  toggleRightPanelTitle: {
    id: "shortcut.toggleRightPanel.title",
    defaultMessage: "Toggle right panel",
  },
  toggleRightPanelDesc: {
    id: "shortcut.toggleRightPanel.desc",
    defaultMessage: "Show or hide the right panel",
  },
  toggleBottomPanelTitle: {
    id: "shortcut.toggleBottomPanel.title",
    defaultMessage: "Toggle bottom panel",
  },
  toggleBottomPanelDesc: {
    id: "shortcut.toggleBottomPanel.desc",
    defaultMessage: "Show or hide the bottom panel — opening it empty starts a terminal",
  },
  closeTabTitle: { id: "shortcut.closeTab.title", defaultMessage: "Close tab" },
  closeTabDesc: {
    id: "shortcut.closeTab.desc",
    defaultMessage: "Close the active tab in the focused panel",
  },
})

/** Groups the settings page renders under, in this order. */
export const SHORTCUT_SECTIONS = ["tabs", "panels"] as const
export type ShortcutSection = (typeof SHORTCUT_SECTIONS)[number]

export interface ShortcutCommand {
  id: string
  section: ShortcutSection
  title: MessageDescriptor
  description: MessageDescriptor
  /** Accelerator strings; the first one is the badge the menus print. */
  defaultKeys: string[]
  run: () => void
  /**
   * False when the current context can't run it: the row stays listed (so its
   * binding is still discoverable) but the key does nothing and menus hide it.
   */
  isAvailable?: () => boolean
}

/** Opens one of the new-tab entries by its tab type. */
const openEntry = (type: TabType, panel: PanelId) => () => {
  const entry = newTabEntries.find((e) => e.type === type)
  if (entry == null) return
  openTabEntry(entry, panel)
}

const entryAvailable = (type: TabType) => (): boolean => {
  const entry = newTabEntries.find((e) => e.type === type)
  if (entry == null) return false
  if (entry.isAvailable?.() === false) return false
  if (__APP_TARGET__ === "web" && type === "browser") return false
  if (entry.requiresWorkspace && activeWorkspaceRoot() == null) return false
  return true
}

/**
 * The panel holding DOM focus, if any. ⌘W is only ours while the user is inside
 * a panel — anywhere else it has to stay the window's own Close, which is why
 * this is an availability check and not something `run` decides.
 */
function focusedPanelWithTab(): PanelId | null {
  const area = document.activeElement?.closest?.("[data-app-shell-focus-area]")
  const name = area?.getAttribute("data-app-shell-focus-area")
  if (name !== "right-panel" && name !== "bottom-panel") return null
  const panelId: PanelId = name === "right-panel" ? "right" : "bottom"
  return useTabsStore.getState()[panelId].activeTabId == null ? null : panelId
}

export const shortcutCommands: ShortcutCommand[] = [
  {
    id: "openFiles",
    section: "tabs",
    title: M.openFilesTitle,
    description: M.openFilesDesc,
    defaultKeys: ["CmdOrCtrl+P"],
    run: openEntry("workspace-browser", "right"),
    isAvailable: entryAvailable("workspace-browser"),
  },
  {
    id: "openReviewTab",
    section: "tabs",
    title: M.openReviewTitle,
    description: M.openReviewDesc,
    defaultKeys: ["Ctrl+Shift+G"],
    run: openEntry("review", "right"),
    isAvailable: entryAvailable("review"),
  },
  {
    id: "openBrowserTab",
    section: "tabs",
    title: M.openBrowserTitle,
    description: M.openBrowserDesc,
    defaultKeys: ["CmdOrCtrl+T"],
    run: openEntry("browser", "right"),
    isAvailable: entryAvailable("browser"),
  },
  {
    id: "openTerminal",
    section: "tabs",
    title: M.openTerminalTitle,
    description: M.openTerminalDesc,
    defaultKeys: ["Control+`"],
    run: openEntry("terminal", "bottom"),
    isAvailable: entryAvailable("terminal"),
  },
  {
    id: "openSideChat",
    section: "tabs",
    title: M.openSideChatTitle,
    description: M.openSideChatDesc,
    defaultKeys: ["CmdOrCtrl+Alt+S"],
    run: openEntry("side-chat", "right"),
    isAvailable: entryAvailable("side-chat"),
  },
  {
    id: "toggleRightPanel",
    section: "panels",
    title: M.toggleRightPanelTitle,
    description: M.toggleRightPanelDesc,
    defaultKeys: ["CmdOrCtrl+\\"],
    run: () => useAppShellStore.getState().toggleRightPanel(),
  },
  {
    id: "toggleBottomPanel",
    section: "panels",
    title: M.toggleBottomPanelTitle,
    description: M.toggleBottomPanelDesc,
    defaultKeys: ["CmdOrCtrl+J"],
    run: toggleBottomPanelWithTerminal,
  },
  {
    id: "closeTab",
    section: "panels",
    title: M.closeTabTitle,
    description: M.closeTabDesc,
    defaultKeys: ["CmdOrCtrl+W"],
    isAvailable: () => focusedPanelWithTab() != null,
    run: () => {
      const panelId = focusedPanelWithTab()
      if (panelId == null) return
      const { activeTabId } = useTabsStore.getState()[panelId]
      if (activeTabId != null) useTabsStore.getState().closeTab(panelId, activeTabId)
    },
  },
]

/** The command a new-tab entry is bound to, so both menus can print its badge. */
const COMMAND_BY_TAB_TYPE: Partial<Record<TabType, string>> = {
  "workspace-browser": "openFiles",
  review: "openReviewTab",
  browser: "openBrowserTab",
  terminal: "openTerminal",
  "side-chat": "openSideChat",
}

export const commandIdForTabType = (type: TabType): string | undefined =>
  COMMAND_BY_TAB_TYPE[type]

export const findCommand = (id: string): ShortcutCommand | undefined =>
  shortcutCommands.find((c) => c.id === id)

const NO_KEYS: string[] = []

/**
 * A command's default bindings, as a stable reference — selectors compare by
 * identity, so returning a fresh array here would re-render on every store tick.
 */
export const defaultKeysFor = (commandId: string): string[] =>
  findCommand(commandId)?.defaultKeys ?? NO_KEYS
