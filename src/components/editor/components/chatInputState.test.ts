import { describe, expect, it } from "vitest"
import { hasComposerDraft } from "./chatInputState"

describe("hasComposerDraft", () => {
  it("allows a queued review comment to be sent without input text", () => {
    expect(
      hasComposerDraft({
        input: "",
        attachmentCount: 0,
        selectedSkillCount: 0,
        hasPendingContext: true,
      })
    ).toBe(true)
  })

  it("rejects a genuinely empty composer", () => {
    expect(
      hasComposerDraft({
        input: "   ",
        attachmentCount: 0,
        selectedSkillCount: 0,
        hasPendingContext: false,
      })
    ).toBe(false)
  })
})
