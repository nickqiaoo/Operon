// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { IntlProvider } from "react-intl"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

type Info = { path?: string; resolvedPath?: string; available: boolean; source: "manual" | "auto" | "missing"; command: string }

const { cli } = vi.hoisted(() => ({ cli: { data: undefined as Record<string, Info> | undefined, isLoading: false } }))

vi.mock("@/lib/settings-queries", () => ({
    settingsKeys: { cliPaths: () => ["settings", "cli-paths"] },
    useCliPaths: () => cli,
    useCliVersion: () => ({ data: undefined }),
}))
vi.mock("@/lib/query-client", () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock("./agents-registry", () => {
    const Icon = () => null
    const entry = (id: string, label: string, cliAdapterId?: string) => ({
        id, legacyTabId: id, label, icon: Icon, cliAdapterId,
        content: () => <div data-testid="agent-body">{`${label} body`}</div>,
    })
    return {
        AGENT_SETTINGS: [
            entry("claude-code", "Claude Code", "claude-code"),
            entry("codex", "Codex", "codex"),
            entry("kimi", "Kimi Code", "kimi"),
            entry("operon", "Operon"),
        ],
    }
})

const { AgentsTab } = await import("./AgentsTab")

const found = (path: string): Info => ({ resolvedPath: path, available: true, source: "auto", command: "x" })
const missing: Info = { available: false, source: "missing", command: "x" }

beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

let root: Root
let container: HTMLDivElement

beforeEach(() => {
    localStorage.clear()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    cli.isLoading = false
    cli.data = {
        "claude-code": missing,
        codex: found("/bin/codex"),
        kimi: { ...found("/bin/kimi"), path: "/gone/kimi" },
    }
})

afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
})

const render = (node: React.ReactNode) =>
    act(() => root.render(<IntlProvider locale="en" onError={() => {}}>{node}</IntlProvider>))

const listOrder = () =>
    [...container.querySelectorAll<HTMLElement>("[data-testid^='settings-agent-']")]
        .map((el) => el.dataset.testid)
        .filter((id) => id !== "settings-agent-header")

const body = () => container.querySelector("[data-testid='agent-body']")?.textContent

describe("AgentsTab", () => {
    it("lists installed agents first and sinks the ones it cannot find", () => {
        render(<AgentsTab />)
        expect(listOrder()).toEqual([
            "settings-agent-codex",
            "settings-agent-kimi",
            "settings-agent-operon",
            "settings-agent-claude-code",
        ])
        expect(container.textContent).toContain("Not found")
    })

    it("opens on the first installed agent when nothing was picked before", () => {
        render(<AgentsTab />)
        expect(body()).toBe("Codex body")
    })

    it("flags an override that no longer resolves", () => {
        render(<AgentsTab initialAgentId="kimi" />)
        expect(container.querySelector("[data-testid='settings-agent-header']")?.textContent).toContain("Needs attention")
    })

    it("lands on a deep-linked agent and remembers what the user picks", async () => {
        render(<AgentsTab initialAgentId="operon" />)
        expect(body()).toBe("Operon body")

        await act(async () => container.querySelector<HTMLElement>("[data-testid='settings-agent-claude-code']")?.click())
        expect(body()).toBe("Claude Code body")
        expect(localStorage.getItem("operon.settings.agents.selected")).toBe("claude-code")
    })

    it("keeps registry order while detection is still running", () => {
        cli.isLoading = true
        cli.data = undefined
        render(<AgentsTab />)
        expect(listOrder()).toEqual([
            "settings-agent-claude-code",
            "settings-agent-codex",
            "settings-agent-kimi",
            "settings-agent-operon",
        ])
    })
})
