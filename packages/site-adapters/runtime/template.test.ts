import { describe, expect, it } from "vitest"
import { evalExpr, render } from "./template.ts"

describe("render / evalExpr", () => {
  it("resolves dotted args and index", () => {
    expect(render("${{ args.limit }}", { args: { limit: 5 } })).toBe(5)
    expect(render("${{ index + 1 }}", { index: 0 })).toBe(1)
  })

  it("resolves item paths", () => {
    expect(
      render("${{ item.owner.name }}", {
        item: { owner: { name: "alice" } },
      }),
    ).toBe("alice")
  })

  it("supports json filter", () => {
    expect(render("${{ args.subreddit | json }}", { args: { subreddit: "programming" } })).toBe(
      '"programming"',
    )
  })

  it("interpolates inside strings", () => {
    expect(
      render("https://example.com/${{ args.id }}.json", { args: { id: 42 } }),
    ).toBe("https://example.com/42.json")
  })

  it("evaluates Math expressions", () => {
    expect(evalExpr("Math.min((args.limit ? args.limit : 20) + 10, 50)", { args: { limit: 5 } })).toBe(
      15,
    )
  })

  it("supports ternary for URLs", () => {
    expect(
      render(
        "${{ args.sort === 'date' ? 'https://a' : 'https://b' }}",
        { args: { sort: "date" } },
      ),
    ).toBe("https://a")
  })
})
