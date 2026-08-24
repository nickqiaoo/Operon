import { describe, it, expect } from "vitest"
import {
  parseCitationPath,
  encodeCitation,
  decodeCitation,
  CITATION_TOKEN_RE,
} from "@/lib/file-citation"
import { remarkFileCitations } from "@/lib/remark-file-citations"

/** Runs the plugin over a paragraph made of the given inline children. */
function runPlugin(children: Array<{ type: string; value?: string }>) {
  const tree = { type: "root", children: [{ type: "paragraph", children }] }
  remarkFileCitations()(tree as never)
  return (tree.children[0] as { children: Array<{ type: string; value?: string }> }).children
}

describe("parseCitationPath", () => {
  it("requires the F: prefix (file kind)", () => {
    expect(parseCitationPath("F:src/app.ts")).toBe("src/app.ts")
    expect(parseCitationPath("src/app.ts")).toBeNull() // no F: → not a file citation
    expect(parseCitationPath("https://x")).toBeNull()
  })
  it("decodes percent-encoding and trims", () => {
    expect(parseCitationPath("F:a/space%20name.ts")).toBe("a/space name.ts")
    expect(parseCitationPath("F: src/app.ts ")).toBe("src/app.ts")
  })
})

describe("encode/decode citation roundtrip", () => {
  it("survives a roundtrip", () => {
    const ref = { path: "src/app.ts", line: 42, endLine: 60 }
    expect(decodeCitation(encodeCitation(ref))).toEqual(ref)
  })
  it("returns null for ordinary inline code", () => {
    expect(decodeCitation("useState")).toBeNull()
    expect(decodeCitation("packages/execution-host-openai-sandbox")).toBeNull()
    expect(decodeCitation("context-report.ts")).toBeNull()
  })
})

describe("CITATION_TOKEN_RE", () => {
  it("matches single line and range tokens", () => {
    const matches = [...("see 【F:src/app.ts†L42】 and 【F:a/b.ts†L1-L20】").matchAll(CITATION_TOKEN_RE)]
    expect(matches).toHaveLength(2)
    expect(matches[0][1]).toBe("F:src/app.ts")
    expect(matches[0][2]).toBe("42")
    expect(matches[1][3]).toBe("20")
  })
  it("tolerates a range without the second L (Claude) and en-dashes", () => {
    // Claude emitted 【F:...types.ts†L210-216】 (no L before 216) — must still match.
    const noL = [...("【F:types.ts†L210-216】".matchAll(CITATION_TOKEN_RE))]
    expect(noL[0][2]).toBe("210")
    expect(noL[0][3]).toBe("216")
    const enDash = [...("【F:a.ts†L1–20】".matchAll(CITATION_TOKEN_RE))]
    expect(enDash[0][3]).toBe("20")
  })
})

describe("remarkFileCitations plugin", () => {
  it("turns a token into an inline-code citation", () => {
    const out = runPlugin([{ type: "text", value: "open 【F:src/app.ts†L42】 now" }])
    // text "open ", inlineCode citation, text " now"
    expect(out.map((n) => n.type)).toEqual(["text", "inlineCode", "text"])
    expect(out[0].value).toBe("open ")
    expect(decodeCitation(out[1].value!)).toEqual({ path: "src/app.ts", line: 42 })
    expect(out[2].value).toBe(" now")
  })

  it("handles a line range (both -L20 and -20 forms)", () => {
    expect(decodeCitation(runPlugin([{ type: "text", value: "【F:a/b.ts†L1-L20】" }])[0].value!))
      .toEqual({ path: "a/b.ts", line: 1, endLine: 20 })
    // Claude's form: 【F:types.ts†L210-216】 (no second L)
    expect(decodeCitation(runPlugin([{ type: "text", value: "【F:types.ts†L210-216】" }])[0].value!))
      .toEqual({ path: "types.ts", line: 210, endLine: 216 })
  })

  it("leaves plain directory / bare-name inline code untouched (the old bug)", () => {
    // These arrive as inlineCode nodes (model wrapped them in backticks). The
    // plugin only rewrites TEXT tokens, so they stay ordinary inline code and
    // decodeCitation later returns null → not clickable.
    const out = runPlugin([
      { type: "inlineCode", value: "packages/execution-host-openai-sandbox" },
      { type: "inlineCode", value: "context-report.ts" },
    ])
    expect(out.map((n) => n.type)).toEqual(["inlineCode", "inlineCode"])
    expect(out.every((n) => decodeCitation(n.value!) === null)).toBe(true)
  })

  it("converts a token even when the model wrapped it in backticks", () => {
    const out = runPlugin([{ type: "inlineCode", value: "【F:src/app.ts†L7】" }])
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe("inlineCode")
    expect(decodeCitation(out[0].value!)).toEqual({ path: "src/app.ts", line: 7 })
  })

  it("leaves a non-file citation (no F:) as text", () => {
    const out = runPlugin([{ type: "text", value: "ref 【docs†L3】 here" }])
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe("text")
    expect(out[0].value).toBe("ref 【docs†L3】 here")
  })

  it("does not descend into code blocks", () => {
    const out = runPlugin([{ type: "code", value: "【F:src/app.ts†L42】" }])
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe("code")
    expect(out[0].value).toBe("【F:src/app.ts†L42】")
  })
})
