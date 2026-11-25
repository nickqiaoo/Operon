import { afterEach, describe, expect, it, vi } from "vitest"
import { clearChatDraft, getChatDraft, getChatDraftFiles, moveChatDraft, setChatDraft, setChatDraftFiles } from "./chat-drafts"
import type { PromptInputFile } from "@/components/ai-elements/prompt-input-context"

afterEach(() => vi.unstubAllGlobals())

describe("moveChatDraft", () => {
  it("hands text and files to the new tab, and closing the old one leaves its files working", () => {
    const revokeObjectURL = vi.fn()
    vi.stubGlobal("URL", { ...URL, revokeObjectURL })
    const file = { id: "f", type: "file", url: "blob:one", mediaType: "image/png", filename: "a.png" } as PromptInputFile
    setChatDraft("chat:old", "hello")
    setChatDraftFiles("chat:old", [file])

    moveChatDraft("chat:old", "chat:new")
    clearChatDraft("chat:old")

    expect(getChatDraft("chat:new")).toBe("hello")
    expect(getChatDraftFiles("chat:new")).toEqual([file])
    expect(getChatDraft("chat:old")).toBe("")
    expect(revokeObjectURL).not.toHaveBeenCalled()
    clearChatDraft("chat:new")
  })
})
