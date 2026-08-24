import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  getRecentChatOptions,
  updateRecentChatOptions,
} from "./recentChatOptions"

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage())
})

describe("recent chat options", () => {
  it("merges preferences independently for each provider", () => {
    updateRecentChatOptions("codex", { modelId: "gpt-5", modeId: "plan" })
    updateRecentChatOptions("codex", { thinkingEffort: "high" })
    updateRecentChatOptions("claude-code", { modeId: "acceptEdits" })

    expect(getRecentChatOptions("codex")).toEqual({
      modelId: "gpt-5",
      modeId: "plan",
      thinkingEffort: "high",
    })
    expect(getRecentChatOptions("claude-code")).toEqual({
      modeId: "acceptEdits",
    })
  })

  it("ignores malformed stored values", () => {
    localStorage.setItem(
      "operon.chat.recent-options:v1",
      JSON.stringify({
        codex: { modelId: 123, modeId: "fullAccess" },
        broken: "not-an-object",
      }),
    )

    expect(getRecentChatOptions("codex")).toEqual({ modeId: "fullAccess" })
    expect(getRecentChatOptions("broken")).toEqual({})
  })

  it("stays non-fatal when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled")
      },
      setItem: () => {
        throw new Error("storage disabled")
      },
    })

    expect(getRecentChatOptions("codex")).toEqual({})
    expect(() => updateRecentChatOptions("codex", { modeId: "plan" })).not.toThrow()
  })
})
