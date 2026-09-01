/**
 * A tab payload is a discriminated union — switch on `type` for rendering.
 * Phase 2b/2c/3/4 will fill in the actual content; for Phase 1 the controller
 * just shuffles these around and the renderer shows a placeholder.
 */
export type TabPayload =
  /**
   * The "file browser" tab — Codex's design is one tab with preview on the
   * left and tree on the right. `selectedPath` (absolute) drives the preview
   * area and the tab title.
   */
  | {
      type: "workspace-browser"
      rootPath: string
      selectedPath: string | null
      /** 1-based source line requested by a file citation click. */
      gotoLine?: number
      /** Bumped so repeated clicks on the same line still scroll. */
      gotoNonce?: number
    }
  | { type: "diff"; filePath: string; before: string; after: string }
  | { type: "review"; rootPath: string }
  | {
      type: "browser"
      instanceId: string
      url: string
      /**
       * Which conversation's browser this tab belongs to. The browser panel
       * swaps its contents when you switch conversations, so every tab needs an
       * owner. Tabs the user opens by hand belong to the active conversation;
       * tabs an agent opens belong to that agent's session.
       * `undefined` means unowned: nothing was active when it opened.
       */
      chatId?: number
    }
  | { type: "terminal"; terminalId: string; cwd: string }
  /**
   * A side chat — a temporary branch of `parentChatId`'s conversation, opened to
   * ask something without disturbing the main thread. `chatId` is a real chat
   * row; closing the tab deletes it. See `@/lib/side-chat`.
   */
  | { type: "side-chat"; chatId: number; parentChatId: number }
  /**
   * Live workflow runs — every run the app knows about, in one tab.
   *
   * Unlike the other tabs this one is never opened by the user: it appears when
   * a workflow starts and is gone once the user closes it, because a workflow is
   * something that HAPPENS to you, not a tool you reach for. One tab holds all
   * runs (they can start several at once, and a tab each would flood the bar).
   */
  | { type: "workflow" }
  | { type: "placeholder"; label: string }

export type TabType = TabPayload["type"]

export interface Tab {
  tabId: string
  title: string
  /** lucide icon name; renderer maps it to a component. Optional for now. */
  icon?: string
  /** A non-closable tab still gets dragged/activated but ignores close clicks. */
  isClosable: boolean
  payload: TabPayload
}

export type PanelId = "right" | "bottom"

/** Drag state shared across the AppShell's DndContext. */
export interface TabDragState {
  draggedTab: Tab
  sourcePanel: PanelId
  /** Updated as the pointer moves over different panels. */
  previewPanel: PanelId
  /** Tab being hovered (drop will insert before it). null = append. */
  overTabId: string | null
}
