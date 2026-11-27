// @vitest-environment jsdom
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { IntlProvider } from "react-intl"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { queryClient } from "@/lib/query-client"
import { MobileChatsScreen } from "./MobileChatsScreen"

const fixtures = vi.hoisted(() => ({
  editor: {
    tabs: [], currentWorkspaceId: 1, currentNodeId: "headless", createChatTab: vi.fn(() => "draft"), setActiveTab: vi.fn(),
  },
  localProviders: vi.fn(),
  remoteProviders: vi.fn(),
  remoteModels: vi.fn(),
  presentAgentSheet: vi.fn(async () => {}),
  native: false,
  onAgentPicked: undefined as ((event: { id: string }) => void) | undefined,
}))

vi.mock("@/lib/api", () => ({ api: { getProviders: fixtures.localProviders } }))
vi.mock("@/lib/chat-api-context", () => ({
  apiOn: () => ({ getProviders: fixtures.remoteProviders, getProviderModels: fixtures.remoteModels }),
}))
vi.mock("@/stores/editor-store", () => ({
  useEditorStore: Object.assign((select: (state: typeof fixtures.editor) => unknown) => select(fixtures.editor), {
    getState: () => fixtures.editor,
  }),
}))
vi.mock("@/lib/native", () => ({
  hasNativeTabBar: () => fixtures.native,
  NativeShell: {
    presentAgentSheet: fixtures.presentAgentSheet,
    addListener: async (_name: string, listener: typeof fixtures.onAgentPicked) => {
      fixtures.onAgentPicked = listener
      return { remove: async () => { fixtures.onAgentPicked = undefined } }
    },
  },
}))
vi.mock("@/lib/chat-queries", () => ({ useChatHistoryList: () => ({ items: [] }) }))
vi.mock("@/lib/spec-queries", () => ({ specKeys: {} }))
vi.mock("@/hooks/useAndroidBackButton", () => ({ useBackHandler: () => {} }))
vi.mock("@/components/editor/ChatPanel", () => ({ ChatPanel: () => null }))
vi.mock("@/components/editor/components/ModelSelectorPanel", () => ({ ProviderIcon: () => null }))
vi.mock("./MobileSpecChatsList", () => ({ MobileSpecChatsList: () => null }))
vi.mock("./MobileSheet", () => ({ MobileSheet: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null }))
vi.mock("./MobileHeader", () => ({ MobileHeader: () => null, useMobileContentBottom: () => "0px", useMobileContentOffset: () => "0px" }))
vi.mock("./PullToRefresh", () => ({ PullToRefresh: ({ children }: { children: ReactNode }) => children }))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  fixtures.native = false
  fixtures.remoteProviders.mockResolvedValue([
    { id: "codex", label: "Codex", logo: "codex", available: false },
    { id: "custom", label: "Operon", logo: "custom", available: true },
  ])
  fixtures.remoteModels.mockResolvedValue({ models: [] })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  queryClient.clear()
  container.remove()
})

const button = (label: string) => Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label)!
const openPicker = async () => {
  await act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en">
        <MobileChatsScreen onOpenSpecChat={() => {}} />
      </IntlProvider>
    </QueryClientProvider>,
  ))
  await act(async () => button("New chat").click())
}

it("disables all rows when the workspace's machine has no usable agents", async () => {
  await openPicker()
  expect(button("Codex").disabled).toBe(true)
  expect(button("Operon").disabled).toBe(true)
  await act(async () => button("Codex").click())
  expect(fixtures.editor.createChatTab).not.toHaveBeenCalled()
  expect(fixtures.localProviders).not.toHaveBeenCalled()
})

it("passes availability to the native picker and rejects a disabled agent event", async () => {
  fixtures.native = true
  fixtures.remoteModels.mockResolvedValue({ models: [{ modelId: "provider/model", name: "Configured model" }] })
  await openPicker()
  expect(fixtures.presentAgentSheet).toHaveBeenCalledWith(expect.objectContaining({
    agents: [expect.objectContaining({ id: "codex", enabled: false }), expect.objectContaining({ id: "custom", enabled: true })],
  }))
  await act(async () => fixtures.onAgentPicked?.({ id: "codex" }))
  expect(fixtures.editor.createChatTab).not.toHaveBeenCalled()

  await act(async () => button("New chat").click())
  await act(async () => fixtures.onAgentPicked?.({ id: "custom" }))
  expect(fixtures.editor.createChatTab).toHaveBeenCalledWith("custom", "Chat")
})
