import { beforeEach, describe, expect, it, vi } from "vitest"

const storage = new Map<string, string>()
const localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value)
  },
  removeItem: (key: string) => {
    storage.delete(key)
  },
}
vi.stubGlobal("window", { localStorage })

const { useAppShellStore } = await import("./app-shell-store")

describe("app shell right panel width", () => {
  beforeEach(() => {
    storage.clear()
    useAppShellStore.setState({
      rightPanelOpen: false,
      rightPanelWidth: 640,
      rightPanelExpanded: false,
    })
  })

  it("preserves the user width when code opens the panel", () => {
    useAppShellStore.getState().setRightPanelOpen(true)

    expect(useAppShellStore.getState()).toMatchObject({
      rightPanelOpen: true,
      rightPanelWidth: 640,
    })
  })

  it("preserves the user width when the panel is closed and reopened", () => {
    const store = useAppShellStore.getState()
    store.toggleRightPanel()
    store.toggleRightPanel()
    store.toggleRightPanel()

    expect(useAppShellStore.getState()).toMatchObject({
      rightPanelOpen: true,
      rightPanelWidth: 640,
    })
  })
})

describe("workspace preview history", () => {
  const TAB = "tab-1"
  const historyOf = (tabId: string) =>
    useAppShellStore.getState().workspacePreviewHistory[tabId]

  beforeEach(() => {
    useAppShellStore.setState({ workspacePreviewHistory: {} })
  })

  it("records each newly previewed file", () => {
    const { pushWorkspacePreviewHistory } = useAppShellStore.getState()
    pushWorkspacePreviewHistory(TAB, "/a.ts")
    pushWorkspacePreviewHistory(TAB, "/b.ts")

    expect(historyOf(TAB)).toEqual({ entries: ["/a.ts", "/b.ts"], index: 1 })
  })

  it("ignores a re-render that lands on the file already shown", () => {
    const { pushWorkspacePreviewHistory } = useAppShellStore.getState()
    pushWorkspacePreviewHistory(TAB, "/a.ts")
    pushWorkspacePreviewHistory(TAB, "/a.ts")

    expect(historyOf(TAB)).toEqual({ entries: ["/a.ts"], index: 0 })
  })

  it("steps back and forward without re-recording where it went", () => {
    const store = useAppShellStore.getState()
    store.pushWorkspacePreviewHistory(TAB, "/a.ts")
    store.pushWorkspacePreviewHistory(TAB, "/b.ts")
    store.pushWorkspacePreviewHistory(TAB, "/c.ts")

    expect(store.stepWorkspacePreviewHistory(TAB, -1)).toBe("/b.ts")
    // The component pushes whatever the preview lands on, including this.
    store.pushWorkspacePreviewHistory(TAB, "/b.ts")
    expect(historyOf(TAB)).toEqual({
      entries: ["/a.ts", "/b.ts", "/c.ts"],
      index: 1,
    })

    expect(store.stepWorkspacePreviewHistory(TAB, 1)).toBe("/c.ts")
    expect(historyOf(TAB).index).toBe(2)
  })

  it("returns null at either end", () => {
    const store = useAppShellStore.getState()
    store.pushWorkspacePreviewHistory(TAB, "/a.ts")

    expect(store.stepWorkspacePreviewHistory(TAB, -1)).toBeNull()
    expect(store.stepWorkspacePreviewHistory(TAB, 1)).toBeNull()
    expect(store.stepWorkspacePreviewHistory("unknown-tab", -1)).toBeNull()
  })

  it("drops the forward stack once you navigate somewhere new", () => {
    const store = useAppShellStore.getState()
    store.pushWorkspacePreviewHistory(TAB, "/a.ts")
    store.pushWorkspacePreviewHistory(TAB, "/b.ts")
    store.pushWorkspacePreviewHistory(TAB, "/c.ts")
    store.stepWorkspacePreviewHistory(TAB, -1)
    store.stepWorkspacePreviewHistory(TAB, -1)
    store.pushWorkspacePreviewHistory(TAB, "/d.ts")

    expect(historyOf(TAB)).toEqual({ entries: ["/a.ts", "/d.ts"], index: 1 })
  })

  it("keeps tabs independent", () => {
    const store = useAppShellStore.getState()
    store.pushWorkspacePreviewHistory(TAB, "/a.ts")
    store.pushWorkspacePreviewHistory("tab-2", "/z.ts")

    expect(historyOf(TAB).entries).toEqual(["/a.ts"])
    expect(historyOf("tab-2").entries).toEqual(["/z.ts"])
  })
})
