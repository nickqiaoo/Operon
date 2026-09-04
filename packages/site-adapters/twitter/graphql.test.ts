import { describe, expect, it } from "vitest"
import { runInNewContext } from "node:vm"
import { CT0_COOKIE_SOURCE, getCt0 } from "./graphql.ts"
import type { AdapterPage } from "../types.ts"

/**
 * `CT0_COOKIE_SOURCE` is JS source evaluated inside the page, so it is tested
 * the way the page runs it: in a context whose only global is `document`.
 *
 * The regression: the source used to hold a regex whose backslashes were
 * escaped one level too far, so `;\\s*` reached the page and matched a literal
 * backslash rather than the space in `; ct0=`. Every cookie-backed twitter
 * command reported "not logged into x.com" even with a signed-in session.
 */
const readCt0 = (cookie: string): string =>
  runInNewContext(CT0_COOKIE_SOURCE, { document: { cookie } }) as string

const pageWithCookie = (cookie: string): AdapterPage => ({
  goto: async () => {},
  evaluate: async (source: string) => runInNewContext(source, { document: { cookie } }),
  fetchJson: async () => ({}),
  wait: async () => {},
  close: async () => {},
})

describe("ct0 cookie source", () => {
  it("reads ct0 when other cookies come first", () => {
    expect(readCt0("guest_id=v1%3A123; ct0=abcdef123456; auth_token=xyz")).toBe("abcdef123456")
  })

  it("reads ct0 at the start and at the end of the cookie string", () => {
    expect(readCt0("ct0=first; auth_token=xyz")).toBe("first")
    expect(readCt0("guest_id=1; ct0=last")).toBe("last")
  })

  it("percent-decodes the value", () => {
    expect(readCt0("ct0=a%2Bb%3Dc")).toBe("a+b=c")
  })

  it("does not match a cookie whose name merely ends in ct0", () => {
    expect(readCt0("not_ct0=nope")).toBe("")
  })

  it("returns empty when signed out", () => {
    expect(readCt0("guest_id=v1%3A123")).toBe("")
    expect(readCt0("")).toBe("")
  })
})

describe("getCt0", () => {
  it("resolves the token from a signed-in page", async () => {
    await expect(getCt0(pageWithCookie("guest_id=1; ct0=token123"))).resolves.toBe("token123")
  })

  it("explains the signed-out case", async () => {
    await expect(getCt0(pageWithCookie("guest_id=1"))).rejects.toThrow(/not logged into x\.com/)
  })
})
