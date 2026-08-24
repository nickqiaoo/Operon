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
