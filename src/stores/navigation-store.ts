import { create } from "zustand"
import type { BoardPageView } from "@/components/channel/BoardPage"

/**
 * Where the desktop shell is. The app navigates by state, not by URL: the chat
 * tabs are many live instances side by side (each may be streaming), which a
 * router's "one current page" can't describe, and every view stays mounted once
 * opened so switching back finds it as it was left. This store is the one place
 * that says which of them is on screen; `App` renders from it.
 *
 * Two layers:
 * - `main` — what fills the area right of the sidebar. Exactly one at a time.
 * - `pages` — full-screen pages over everything (Settings, Plugins…), a stack:
 *   Plugins opened from inside Settings sits on top, and Back lands on Settings.
 */
export type MainView =
  /** The editor: the workspace's chat / terminal tabs. */
  | { kind: "workbench" }
  | { kind: "assistant" }
  | { kind: "inbox" }
  /** Board and Channels are one page with two views, so they share state. */
  | { kind: "board"; view: BoardPageView }
  /** A Spec keeps the workbench's panels and chat surface, with its own header. */
  | { kind: "spec"; taskId: number; projectId: number }

export type MainViewKind = MainView["kind"]

export type FullPage =
  /** `tab`: the Settings tab to land on when something deep-linked in. */
  | { kind: "settings"; tab?: string }
  /** `pluginId`: open straight onto that plugin's detail (from a skill / MCP server it provides). */
  | { kind: "plugins"; pluginId?: string }
  | { kind: "canvas" }
  /** `cronjobId`: the task to select (from the card a `schedule_create` call renders). */
  | { kind: "schedule"; cronjobId?: number }

export type FullPageKind = FullPage["kind"]

interface NavigationStore {
  main: MainView
  /** Full-screen pages, bottom to top. The last one is what the user sees. */
  pages: readonly FullPage[]
  /**
   * Main views opened at least once. They mount on first open and then stay
   * mounted (hidden while another is up), so their inner state survives.
   */
  visited: ReadonlySet<MainViewKind>
  /** The Board page keeps showing the view it was last on while it is hidden. */
  lastBoardView: BoardPageView | null
  /** A task the Board should open its detail on; cleared once the Board consumes it. */
  boardTaskId: number | null
  /** A chat to show at its newest message; cleared once its transcript has moved there. */
  latestChatRequest: number | null

  showMain: (view: MainView) => void
  /** Back to the editor. */
  showWorkbench: () => void
  /** The Board with one task's detail open (an inbox notification, a task card in a chat). */
  openTask: (taskId: number) => void
  clearBoardTask: () => void
  requestChatLatest: (chatId: number) => void
  clearChatLatestRequest: () => void
  /** Open a full-screen page on top. One already in the stack moves to the top. */
  openPage: (page: FullPage) => void
  closePage: (kind: FullPageKind) => void
}

export const useNavigationStore = create<NavigationStore>()((set) => ({
  main: { kind: "workbench" },
  pages: [],
  visited: new Set<MainViewKind>(["workbench"]),
  lastBoardView: null,
  boardTaskId: null,
  latestChatRequest: null,

  showMain: (view) =>
    set((state) => ({
      main: view,
      visited: state.visited.has(view.kind) ? state.visited : new Set([...state.visited, view.kind]),
      lastBoardView: view.kind === "board" ? view.view : state.lastBoardView,
    })),
  showWorkbench: () => set((state) => (state.main.kind === "workbench" ? state : { main: { kind: "workbench" } })),
  openTask: (taskId) => {
    set({ boardTaskId: taskId })
    useNavigationStore.getState().showMain({ kind: "board", view: "board" })
  },
  clearBoardTask: () => set({ boardTaskId: null }),
  requestChatLatest: (chatId) => set({ latestChatRequest: chatId }),
  clearChatLatestRequest: () => set({ latestChatRequest: null }),

  openPage: (page) =>
    set((state) => ({ pages: [...state.pages.filter((p) => p.kind !== page.kind), page] })),
  closePage: (kind) =>
    set((state) => (state.pages.some((p) => p.kind === kind) ? { pages: state.pages.filter((p) => p.kind !== kind) } : state)),
}))
