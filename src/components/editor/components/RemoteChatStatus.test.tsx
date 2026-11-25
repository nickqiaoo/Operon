// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { IntlProvider } from "react-intl"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const { status } = vi.hoisted(() => ({ status: { current: {} as { label?: string; online?: boolean } } }))
vi.mock("@/lib/machine-reachability", () => ({
  useRemoteMachine: () => ({ ...status.current, unreachable: status.current.online === false }),
}))
vi.mock("@/lib/api", () => ({ api: {}, apiFor: vi.fn() }))
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }))

const { ChatLoadFailed, RemoteMachineLabel } = await import("./RemoteChatStatus")
const { ApiError } = await import("@/lib/api-client")

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  status.current = {}
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const render = (node: React.ReactNode) =>
  act(() => root.render(<IntlProvider locale="en" onError={() => {}}>{node}</IntlProvider>))

describe("ChatLoadFailed", () => {
  it("names the machine a remote chat lives on when it is offline", () => {
    status.current = { label: "MacBook Air", online: false }
    render(<ChatLoadFailed nodeId="n1" error={new ApiError(503, "offline", "node_offline")} onRetry={() => {}} />)
    expect(container.textContent).toContain("MacBook Air is offline")
    expect(container.textContent).toContain("It will load once that machine is back online")
  })

  it("says it can't reach a machine listed online that did not answer", () => {
    status.current = { label: "MacBook Air", online: true }
    render(<ChatLoadFailed nodeId="n1" error={new ApiError(504, "timeout")} onRetry={() => {}} />)
    expect(container.textContent).toContain("Can't reach MacBook Air")
  })

  it("shows the error itself for this machine's chat", () => {
    render(<ChatLoadFailed error={new ApiError(500, "database is locked")} onRetry={() => {}} />)
    expect(container.textContent).toContain("Couldn't load this conversation")
    expect(container.textContent).toContain("database is locked")
  })

  it("tries again when asked, and by itself once the machine comes back online", () => {
    const onRetry = vi.fn()
    status.current = { label: "MacBook Air", online: false }
    render(<ChatLoadFailed nodeId="n1" error={new ApiError(503, "offline", "node_offline")} onRetry={onRetry} />)
    act(() => container.querySelector("button")!.click())
    expect(onRetry).toHaveBeenCalledTimes(1)

    status.current = { label: "MacBook Air", online: true }
    render(<ChatLoadFailed nodeId="n1" error={new ApiError(503, "offline", "node_offline")} onRetry={onRetry} />)
    expect(onRetry).toHaveBeenCalledTimes(2)
  })
})

describe("RemoteMachineLabel", () => {
  it("names the machine, and says when it is offline", () => {
    status.current = { label: "MacBook Air", online: true }
    render(<RemoteMachineLabel nodeId="n1" />)
    expect(container.textContent).toBe("MacBook AirRemote")
    status.current = { label: "MacBook Air", online: false }
    render(<RemoteMachineLabel nodeId="n1" />)
    expect(container.textContent).toBe("MacBook AirOffline")
  })
})
