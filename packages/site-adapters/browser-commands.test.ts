// @vitest-environment node
import { runInNewContext } from "node:vm"
import { beforeAll, afterAll, describe, expect, it } from "vitest"
import * as sa from "./index.ts"

/**
 * Every browser-backed command, run against a fake page that reproduces two
 * rules of the real browser client:
 *
 *  1. A source that looks callable is invoked (`readOnlyEvaluationExpression`).
 *     Without this, sources written as `async () => {…}` are only parsed, and
 *     a test that "passes" has not run the command's actual request.
 *  2. `fetch` is held to GET/HEAD, like the read-only evaluation guard.
 *
 * This is what catches the class of bug that got past review before: a regex
 * escaped one level too far so a cookie read silently found nothing, and a POST
 * that the guard rejects before it reaches the network.
 *
 * It asserts the injected source is valid and permitted — not that the sites
 * answer, which needs a signed-in browser.
 */

const COOKIE = ["ct0=FAKECT0", "auth_token=FAKEAUTH", "SESSDATA=FAKESESS", "bili_jct=FAKEJCT", "z_c0=FAKEZC0", "reddit_session=FAKERS"].join("; ")

const valueFor = (site: string, name: string): unknown => {
  const n = name.toLowerCase()
  if (n === "url") {
    if (site === "twitter") return "https://x.com/sama/status/1234567890123456789"
    if (site === "youtube") return "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    return "https://example.com/"
  }
  if (/(query|keyword|q|search)/.test(n)) return "ai"
  if (/bvid/.test(n)) return "BV1xx411c7mD"
  if (/(uid|mid|^id$|aid|topic)/.test(n)) return "1"
  if (/(user|author|actor|screen)/.test(n)) return "sama"
  if (/(subreddit|node|^name$)/.test(n)) return "programming"
  if (/(tag|category)/.test(n)) return "typescript"
  return "1"
}

/** The client's own test for "this source is a function to call". */
const looksCallable = (s: string) =>
  /^(?:async\s+)?function\b/u.test(s) || /^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/u.test(s)

interface RunResult { requests: string[]; sources: string[]; evalErrors: string[] }

async function runInFakePage(id: string, argDefs: ReadonlyArray<{ name: string; required?: boolean }>, site: string): Promise<RunResult> {
  const requests: string[] = []
  const sources: string[] = []
  const evalErrors: string[] = []
  const emptyNode = { innerText: "", textContent: "", getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [] }
  const ctx: Record<string, unknown> = {
    document: { cookie: COOKIE, querySelector: () => null, querySelectorAll: () => [], title: "", body: emptyNode },
    location: { href: "https://example.com/", hostname: "example.com", pathname: "/" },
    window: { __INITIAL_STATE__: {}, ytInitialData: {}, ytcfg: { data_: {} }, scrollTo: () => {}, scrollBy: () => {} },
    navigator: { userAgent: "vm" },
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Promise, Set, Map, Error,
    AbortController, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, URL, URLSearchParams,
    console: { log: () => {} },
    fetch: async (url: string, init?: { method?: string }) => {
      const method = String(init?.method ?? "GET").toUpperCase()
      requests.push(`${method} ${String(url)}`)
      if (method !== "GET" && method !== "HEAD") {
        throw new Error("Read-only browser evaluation only allows GET and HEAD requests")
      }
      return { ok: true, status: 200, statusText: "OK", json: async () => ({}), text: async () => "{}", headers: { get: () => null } }
    },
  }
  ;(ctx.window as Record<string, unknown>).fetch = ctx.fetch

  const evaluate = async (source: string) => {
    sources.push(source)
    const trimmed = source.trim()
    try {
      return await runInNewContext(looksCallable(trimmed) ? `(${trimmed})()` : `(${trimmed})`, ctx, { timeout: 5000 })
    } catch (e) {
      evalErrors.push((e as Error).message)
      throw e
    }
  }
  const browser = { tabs: { new: async () => ({ goto: async () => {}, playwright: { evaluate } }) } }
  const args: Record<string, unknown> = {}
  for (const a of argDefs) if (a.required) args[a.name] = valueFor(site, a.name)
  try {
    await sa.run(id, { ...args, browser })
  } catch {
    // Commands legitimately give up against empty data; only the injected
    // source's validity is under test here.
  }
  return { requests, sources, evalErrors }
}

const originalFetch = globalThis.fetch
const browserCommands = sa.list().filter((c) => c.browser)

/**
 * Collected once: several commands sleep between steps, so running each command
 * per assertion would take minutes for no extra coverage.
 */
const results = new Map<string, RunResult>()

beforeAll(async () => {
  // Host-side lookups (twitter's queryId source) must not hit the network here;
  // every caller of one has a pinned fallback.
  globalThis.fetch = (async () => { throw new Error("offline in test") }) as typeof fetch
  for (const info of browserCommands) {
    const id = `${info.site}.${info.name}`
    results.set(id, await runInFakePage(id, info.args ?? [], info.site))
  }
}, 120_000)
afterAll(() => { globalThis.fetch = originalFetch })

describe("browser-backed commands inject usable source", () => {
  it("covers every browser command", () => {
    expect(browserCommands.length).toBeGreaterThan(40)
  })

  it.each(browserCommands.map((c) => [`${c.site}.${c.name}`, c] as const))(
    "%s",
    async (id) => {
      const { requests, sources, evalErrors } = results.get(id)!
      expect(sources.length, `${id} injected no source`).toBeGreaterThan(0)

      const blocked = evalErrors.filter((m) => /only allows GET and HEAD/.test(m))
      expect(blocked, `${id} issues a request the read-only guard rejects`).toEqual([])

      const broken = evalErrors.filter((m) =>
        /SyntaxError|Unexpected token|Invalid regular expression|is not defined|is not a function/.test(m))
      expect(broken, `${id} injected source that does not run`).toEqual([])

      expect(requests.every((r) => r.startsWith("GET ") || r.startsWith("HEAD ")), `${id} requests: ${requests.join(", ")}`).toBe(true)
    },
  )
})

describe("regexes reaching the page", () => {
  it("never carries a literal backslash", () => {
    const offenders: string[] = []
    for (const info of browserCommands) {
      for (const source of results.get(`${info.site}.${info.name}`)!.sources) {
        for (const m of source.matchAll(/\/(?:[^/\n\\]|\\.)+\/[gimsuy]*/g)) {
          // `\\s` in page source matches a backslash, not whitespace — the ct0 bug.
          if (m[0].includes("\\\\")) offenders.push(`${info.site}.${info.name}: ${m[0]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
