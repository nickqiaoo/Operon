import { beforeEach, describe, expect, it } from "vitest"
import { useNavigationStore } from "./navigation-store"

const initial = useNavigationStore.getState()

beforeEach(() => {
  useNavigationStore.setState(initial, true)
})

const kinds = () => useNavigationStore.getState().pages.map((page) => page.kind)

describe("full-screen page stack", () => {
  it("stacks a page opened from another on top, and Back lands on the one below", () => {
    const { openPage, closePage } = useNavigationStore.getState()
    openPage({ kind: "settings", tab: "skills" })
    openPage({ kind: "plugins" })
    expect(kinds()).toEqual(["settings", "plugins"])

    closePage("plugins")
    expect(useNavigationStore.getState().pages).toEqual([{ kind: "settings", tab: "skills" }])
  })

  it("moves a page already open to the top with its new target", () => {
    const { openPage } = useNavigationStore.getState()
    openPage({ kind: "settings" })
    openPage({ kind: "plugins" })
    openPage({ kind: "settings", tab: "extensions" })
    expect(useNavigationStore.getState().pages).toEqual([{ kind: "plugins" }, { kind: "settings", tab: "extensions" }])
  })

  it("leaves the state untouched when closing a page that is not open", () => {
    const before = useNavigationStore.getState()
    before.closePage("canvas")
    expect(useNavigationStore.getState()).toBe(before)
  })
})

describe("main view", () => {
  it("records each view the first time it is shown, so it stays mounted afterwards", () => {
    const { showMain, showWorkbench } = useNavigationStore.getState()
    showMain({ kind: "inbox" })
    showWorkbench()
    const { main, visited } = useNavigationStore.getState()
    expect(main).toEqual({ kind: "workbench" })
    expect([...visited].sort()).toEqual(["inbox", "workbench"])
  })

  it("remembers the last Board view while another view is up", () => {
    const { showMain, showWorkbench } = useNavigationStore.getState()
    showMain({ kind: "board", view: "channels" })
    showWorkbench()
    expect(useNavigationStore.getState().lastBoardView).toBe("channels")
  })

  it("opens a task on the Board view and keeps the target until the Board consumes it", () => {
    const { showMain, openTask } = useNavigationStore.getState()
    showMain({ kind: "board", view: "channels" })
    openTask(42)
    expect(useNavigationStore.getState().main).toEqual({ kind: "board", view: "board" })
    expect(useNavigationStore.getState().boardTaskId).toBe(42)

    useNavigationStore.getState().clearBoardTask()
    expect(useNavigationStore.getState().boardTaskId).toBeNull()
  })
})
