import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useTabsStore } from "@/stores/tabs-store"

const manager = vi.hoisted(() => ({
  ensure: vi.fn(),
  setBrowserUseActive: vi.fn(),
  setBrowserUseCursor: vi.fn(),
  setBrowserUseViewport: vi.fn(),
  setCaptureSurface: vi.fn(),
}))

vi.mock("./BrowserManager", () => ({ browserManager: manager }))

import { installBrowserUseBridge } from "./browser-use-bridge"

interface BrowserUseRequest {
  id: number
  action: string
  payload?: unknown
}

type RequestHandler = (request: BrowserUseRequest) => Promise<void>

let requestHandler: RequestHandler | null = null
const respond = vi.fn()

beforeEach(() => {
  requestHandler = null
  respond.mockReset()
  manager.ensure.mockReset()
  manager.setBrowserUseActive.mockReset()
  manager.setBrowserUseCursor.mockReset()
  manager.setBrowserUseViewport.mockReset()
  manager.setCaptureSurface.mockReset()
  useTabsStore.setState({
    right: { tabs: [], activeTabId: null },
    bottom: { tabs: [], activeTabId: null },
    byWorkspace: {},
    currentWorkspaceId: null,
  })

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      electronAPI: {
        browser: {
          onRequest: (handler: RequestHandler) => {
            requestHandler = handler
            return () => {
              requestHandler = null
            }
          },
          respond,
        },
      },
    },
  })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window")
})

describe("Browser Use renderer bridge", () => {
  it("parks a webview first, then writes background-conversation tabs into the UI store", async () => {
    const order: string[] = []
    manager.ensure.mockImplementation(() => {
      order.push("ensure")
      return {}
    })
    const unsubscribeStore = useTabsStore.subscribe(() => order.push("store"))
    const uninstall = installBrowserUseBridge()

    try {
      expect(requestHandler).not.toBeNull()
      await requestHandler?.({
        id: 1,
        action: "createTab",
        payload: { url: "about:blank", chatId: "4242" },
      })

      const response = respond.mock.calls[0]?.[0] as
        | { id: number; ok: boolean; result?: unknown }
        | undefined
      expect(response).toMatchObject({ id: 1, ok: true })
      expect(typeof response?.result).toBe("string")
      expect(manager.ensure).toHaveBeenCalledWith(
        response?.result,
        "about:blank",
        "4242"
      )
      expect(order.slice(0, 2)).toEqual(["ensure", "store"])
      expect(useTabsStore.getState().right.tabs[0]?.payload).toMatchObject({
        type: "browser",
        instanceId: response?.result,
        url: "about:blank",
        chatId: 4242,
      })
    } finally {
      uninstall()
      unsubscribeStore()
    }
  })

  it("returns the genuinely selected browser tab for each conversation", async () => {
    useTabsStore.setState({
      right: {
        tabs: [
          {
            tabId: "browser:a1",
            title: "A1",
            isClosable: true,
            payload: { type: "browser", instanceId: "a1", url: "", chatId: 1 },
          },
          {
            tabId: "browser:a2",
            title: "A2",
            isClosable: true,
            payload: { type: "browser", instanceId: "a2", url: "", chatId: 1 },
          },
          {
            tabId: "browser:b1",
            title: "B1",
            isClosable: true,
            payload: { type: "browser", instanceId: "b1", url: "", chatId: 2 },
          },
        ],
        activeTabId: "browser:a1",
      },
      bottom: { tabs: [], activeTabId: null },
    })
    const uninstall = installBrowserUseBridge()

    try {
      await requestHandler?.({ id: 2, action: "getTabPresentation", payload: {} })
      expect(respond).toHaveBeenCalledWith({
        id: 2,
        ok: true,
        result: { activeInstanceIds: ["a1", "b1"] },
      })
    } finally {
      uninstall()
    }
  })

  it("routes cursor and viewport commands to a separate BrowserManager host", async () => {
    const uninstall = installBrowserUseBridge()

    try {
      await requestHandler?.({
        id: 3,
        action: "setBrowserUseCursor",
        payload: { instanceId: "tab-a", cursor: { x: 12, y: 34 } },
      })
      await requestHandler?.({
        id: 4,
        action: "setBrowserViewport",
        payload: { instanceId: "tab-a", size: { width: 1280, height: 800 } },
      })
      await requestHandler?.({
        id: 5,
        action: "setBrowserViewport",
        payload: { instanceId: "tab-a", size: null },
      })

      expect(manager.setBrowserUseCursor).toHaveBeenCalledWith("tab-a", { x: 12, y: 34 })
      expect(manager.setBrowserUseViewport).toHaveBeenNthCalledWith(1, "tab-a", {
        width: 1280,
        height: 800,
      })
      expect(manager.setBrowserUseViewport).toHaveBeenNthCalledWith(2, "tab-a", null)
    } finally {
      uninstall()
    }
  })
})
