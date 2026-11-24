// @vitest-environment jsdom
import { act, useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ExternalAgentView } from "@shared/external-agent"

// Each feed records which machine it watches while mounted; what is under test
// is which machines get which feeds.
const { mounted } = vi.hoisted(() => ({ mounted: new Map<string, number>() }))
function recorder(name: string) {
  return function Feed({ nodeId }: { nodeId?: string }) {
    useEffect(() => {
      const key = `${name}:${nodeId}`
      mounted.set(key, (mounted.get(key) ?? 0) + 1)
      return () => {
        mounted.set(key, (mounted.get(key) ?? 1) - 1)
        if (mounted.get(key) === 0) mounted.delete(key)
      }
    }, [nodeId])
    return null
  }
}
vi.mock("./PendingInputSync", () => ({ PendingInputSync: recorder("pending") }))
vi.mock("./ExternalAgentsSync", () => ({ ExternalAgentsSync: recorder("agents") }))
vi.mock("./WorkflowRunsSync", () => ({ RemoteWorkflowRunsSync: recorder("workflow") }))
vi.mock("@/lib/api", () => ({ api: {}, apiFor: vi.fn() }))
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }))

const { RemoteNodeFeeds, activeRemoteAgentNodeIds } = await import("./RemoteNodeFeeds")
const { useEditorStore } = await import("@/stores/editor-store")
const { useExternalAgentsStore } = await import("@/stores/external-agents-store")
const { LOCAL_NODE } = await import("@/lib/chat-ref")

const agent = (agentId: string, status: ExternalAgentView["status"], remoteNode?: string): ExternalAgentView => ({
  agentId,
  parentChatId: 1,
  description: agentId,
  model: "default",
  childChatId: 9,
  providerId: "codex",
  status,
  ...(remoteNode ? { remote: { nodeId: remoteNode, machine: remoteNode, workspace: "repo" } } : {}),
})

const feeds = () => [...mounted.keys()].sort()

let root: Root
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mounted.clear()
  useEditorStore.setState({ tabs: [], activeTabId: "", currentWorkspaceId: null, currentProjectId: null, currentNodeId: null, workspaceStates: {} })
  useExternalAgentsStore.getState().reset()
  root = createRoot(document.createElement("div"))
  await act(async () => root.render(<RemoteNodeFeeds />))
})
afterEach(async () => {
  await act(async () => root.unmount())
})

describe("activeRemoteAgentNodeIds", () => {
  it("lists the machines running or queueing an agent this machine started, once each, sorted", async () => {
    await act(async () => useExternalAgentsStore.getState().sync(LOCAL_NODE, [
      agent("a", "running", "node-c"),
      agent("b", "queued", "node-b"),
      agent("c", "running", "node-b"),
      agent("d", "completed", "node-d"),
      agent("e", "idle", "node-e"),
      agent("f", "running"),
    ]))
    expect(activeRemoteAgentNodeIds(useExternalAgentsStore.getState().agents)).toEqual(["node-b", "node-c"])
  })

  it("ignores another machine's own feed, whose agents are not this machine's to follow", async () => {
    await act(async () => useExternalAgentsStore.getState().sync("node-b", [agent("a", "running", "node-x")]))
    expect(activeRemoteAgentNodeIds(useExternalAgentsStore.getState().agents)).toEqual([])
  })
})

describe("RemoteNodeFeeds", () => {
  it("mounts all three feeds for a machine with an open tab", async () => {
    await act(async () => {
      useEditorStore.setState({ tabs: [{ id: "chat:node-b:3", title: "x", type: "chat", closable: true, chatId: 3, nodeId: "node-b" }] })
    })
    expect(feeds()).toEqual(["agents:node-b", "pending:node-b", "workflow:node-b"])
  })

  it("watches pending input of a machine running a remote agent, with no tab open", async () => {
    await act(async () => useExternalAgentsStore.getState().sync(LOCAL_NODE, [agent("a", "running", "node-b")]))
    expect(feeds()).toEqual(["pending:node-b"])

    // The agent finishing lets go of that machine.
    await act(async () => useExternalAgentsStore.getState().upsert(LOCAL_NODE, agent("a", "completed", "node-b")))
    expect(feeds()).toEqual([])
  })

  it("watches a machine once when it has both a tab and a running agent", async () => {
    await act(async () => {
      useExternalAgentsStore.getState().sync(LOCAL_NODE, [agent("a", "running", "node-b")])
      useEditorStore.setState({ tabs: [{ id: "chat:node-b:3", title: "x", type: "chat", closable: true, chatId: 3, nodeId: "node-b" }] })
    })
    expect(feeds()).toEqual(["agents:node-b", "pending:node-b", "workflow:node-b"])
    expect(mounted.get("pending:node-b")).toBe(1)

    // Closing the tab keeps pending input watched while the agent runs.
    await act(async () => useEditorStore.setState({ tabs: [] }))
    expect(feeds()).toEqual(["pending:node-b"])
  })
})
