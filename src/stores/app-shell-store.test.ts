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
vi.stubGlobal("localStorage", localStorage)

const { useAppShellStore } = await import("./app-shell-store")
const { useSessionPanelStore } = await import("./session-panel-store")

describe("right panel and session panel", () => {
  beforeEach(() => {
    storage.clear()
    useAppShellStore.setState({ rightPanelOpen: false, rightPanelExpanded: false })
    useSessionPanelStore.setState({ open: true, owner: "chat-1", autoClosed: false })
  })

  it.each(["setRightPanelOpen", "toggleRightPanel"] as const)(
    "collapses the session panel when opening with %s and restores it on close",
    (action) => {
      const store = useAppShellStore.getState()
      if (action === "setRightPanelOpen") store.setRightPanelOpen(true)
      else store.toggleRightPanel()

      expect(useAppShellStore.getState().rightPanelOpen).toBe(true)
      expect(useSessionPanelStore.getState()).toMatchObject({ open: false, owner: "chat-1" })

      if (action === "setRightPanelOpen") store.setRightPanelOpen(false)
      else store.toggleRightPanel()

      expect(useAppShellStore.getState().rightPanelOpen).toBe(false)
      expect(useSessionPanelStore.getState().open).toBe(true)
    },
  )

  it("leaves the session panel closed on right-panel close when it was already closed", () => {
    useSessionPanelStore.setState({ open: false })
    const store = useAppShellStore.getState()
    store.setRightPanelOpen(true)
    expect(useSessionPanelStore.getState().open).toBe(false)

    store.setRightPanelOpen(false)
    expect(useSessionPanelStore.getState().open).toBe(false)
  })

  it("keeps a session panel the user dismissed by hand closed after the right panel closes", () => {
    const store = useAppShellStore.getState()
    store.setRightPanelOpen(true) // auto-closes the open session panel
    useSessionPanelStore.getState().setOpen(true) // user reopens it
    useSessionPanelStore.getState().setOpen(false) // user dismisses it again

    store.setRightPanelOpen(false)
    expect(useSessionPanelStore.getState().open).toBe(false)
  })

  it("preserves an explicitly reopened session panel when the right panel is already open", () => {
    const store = useAppShellStore.getState()
    store.setRightPanelOpen(true)
    useSessionPanelStore.getState().setOpen(true)

    store.setRightPanelOpen(true)
    expect(useSessionPanelStore.getState().open).toBe(true)

    store.setRightPanelOpen(false)
    expect(useSessionPanelStore.getState().open).toBe(true)
  })
})

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

  it("repairs a width saved while the editor was hidden", async () => {
    localStorage.setItem("operon-app-shell", JSON.stringify({
      state: { rightPanelOpen: true, rightPanelWidth: 280, bottomPanelHeight: 200 },
      version: 1,
    }))

    await useAppShellStore.persist.rehydrate()

    expect(useAppShellStore.getState()).toMatchObject({
      rightPanelOpen: true,
      rightPanelWidth: 720,
      bottomPanelHeight: 200,
    })
    expect(JSON.parse(localStorage.getItem("operon-app-shell")!).version).toBe(2)
  })

  it("keeps a valid saved width when upgrading", async () => {
    localStorage.setItem("operon-app-shell", JSON.stringify({
      state: { rightPanelWidth: 640 },
      version: 1,
    }))

    await useAppShellStore.persist.rehydrate()

    expect(useAppShellStore.getState().rightPanelWidth).toBe(640)
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
