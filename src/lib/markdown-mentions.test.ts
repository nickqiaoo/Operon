import { describe, expect, it } from "vitest"
import { mentionPattern } from "./markdown-mentions"

const names = (text: string) => {
  const pattern = mentionPattern([{ name: "builder" }, { name: "luna" }, { name: "luna-lead" }])!
  return [...text.matchAll(pattern)].map((m) => m[1])
}

describe("mentionPattern", () => {
  it("matches member names after @, next to CJK punctuation", () => {
    expect(names("我在,@builder。交给 @luna-lead 处理")).toEqual(["builder", "luna-lead"])
  })

  it("leaves emails, unknown names and longer words alone", () => {
    expect(names("me@builder.dev @someone @builder2 @lunatic")).toEqual([])
  })

  it("is case-insensitive", () => {
    expect(names("@Builder")).toEqual(["Builder"])
  })

  it("returns null with no names", () => {
    expect(mentionPattern([])).toBeNull()
  })
})
