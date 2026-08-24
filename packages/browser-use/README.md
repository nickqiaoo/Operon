# @operon/browser-use

> **On the oracle and differential suites.** Notes in this package point at recordings made
> against a reference client. Those suites are not in this repository: they run our
> implementation side by side with a third-party client that is not ours to redistribute, so
> without it there is no yardstick and nothing to run. Put the reference in place locally and
> they work. What they guard still holds — the frame shapes came from recording real traffic
> rather than from reading a minified bundle, and that distinction is the whole point.


Browser control for operon: driving the in-app browser, or the user's own Chrome.

It sits alongside `@operon/computer-use` and reuses its node_repl runtime,
nativePipe, framing and MCP adapter, supplying only the SDK and the backend.
Framework-agnostic: confirmation goes through `nodeRepl.createElicitation` and the
host decides how to present it, with no dependency on any agent framework.

## Layout

```
wire.ts             Framing (4-byte native-endian uint32 + UTF-8 JSON), socket
                    discovery, and the BrowserInfo schema
JsonRpcPeer.ts      JSON-RPC over one connection: unframe, dispatch, frame the
                    reply. Knows no specific method.
IabBackend.ts       Socket server, getInfo in echo mode, per-session tab
                    ownership. The CDP side is abstracted behind CdpDriver.
sdk/                The client the model sees
../../electron/browser-use-driver.ts   The real CdpDriver, and the only place
                                       that touches Electron
```

## The SDK

The product runtime uses our own client. A vendored reference client is kept only
as a test oracle, is gitignored, and never enters a build. The production entry
point exports `setupBrowserRuntime` alone, loaded through an exact SHA-256
allowlist.

| | verified by |
|---|---|
| `sdk/session.ts` — the session triple, including subagent to thread_id | differential |
| `sdk/transport.ts` — nativePipe, JSON-RPC client, automatic session merge | differential |
| `sdk/discovery.ts` — readdir, getInfo, IAB filtered by session and flavour | differential |
| `sdk/index.ts` — Agent, Browsers, Browser, Tabs, Tab.goto | differential |
| `injectPlaywright(tab)` — injects Playwright's injectedScript (in `sdk/internals.ts`, never on the model surface) | structural differential plus cache semantics |
| `sdk/playwright.ts` — locator, click, fill, textContent, isVisible, count, getBy*, ariaSnapshot | real Chrome, end to end |
| The CDP event channel and `Fetch.requestPaused` continuation | real Chrome; without it every real page hangs |
| Full actionability (`checkElementStates`: visible, enabled, stable) and hit testing (`expectHitTarget`) | real Chrome, mutation-verified |
| Same-origin iframes, including multi-level nesting and CSS-scaled coordinates | real Chrome, mutation-verified |
| Page-side exceptions propagating (`exceptionDetails`), and deterministic failures thrown immediately | real Chrome, mutation-verified |
| Cross-origin OOPIFs: tag, resolve the frame or target, inject into that target or execution context, convert coordinates level by level | real Chrome, mutation-verified |
| The Locator action surface (hover, press, check, selectOption, nth, filter, waitFor, dragTo, setInputFiles…) | real Chrome, mutation-verified |
| `tab.screenshot()`, title, url, back, forward, reload | real Chrome |
| Dialogs (alert, confirm, prompt, beforeunload) handled explicitly through `getJsDialog` | real Chrome, mutation-verified |
| `capabilities.get("visibility" / "viewport")` | wired to the backend's `executeUnhandledCommand` |
| `frameLocator`, same-origin, cross-origin and nested | real Chrome, mutation-verified |
| `tab.cua.*`, the screenshot-and-coordinates fallback | real Chrome, mutation-verified |
| `tab.clipboard` and `browser.user.*` | real Chrome; `user.*` only means anything for the extension |
| `playwright.waitForEvent("download")` waiting for a terminal state, and `playwright.waitForLoadState` | real Chrome, mutation-verified |
| `tab.dom_cua.*`, `tabs.finalize`, `browsers.getForUrl` | real Chrome, mutation-verified |
| `tabs.content` | extraction in a temporary background tab, closed afterwards |
| `ContentAPI.export` and `exportGsuite` | DOM export plus explicit-format Google Workspace download |
| `tab.dev.logs`, and the discriminated JS dialog objects | public object shapes, covered by contract tests |
| Nested OOPIF chains: auto-attached child targets, frame contexts reusing an ancestor process, per-level scaling | real Chrome, read and click |
| Response metadata (tool surface, redacted URLs, post-action screenshots) | after-submitted-code hook plus MCP `_meta` |

The public core API is constrained jointly by `documentation.test.ts`,
`sdk-shape.test.ts` and the real-Chrome suites.

## Running the tests, and diagnosing cascading timeouts

```bash
# Two passes, which is what `npm test` in this package does: everything else in
# parallel, then sdk-locator-real alone in its own vitest process.
npx vitest run packages/browser-use --exclude '**/sdk-locator-real.test.ts'
npx vitest run packages/browser-use/sdk-locator-real.test.ts
```

**If `sdk-locator-real` produces a dozen tests cascading into 60s timeouts,
usually starting from the clipboard test, run
`node packages/browser-use/docs/headless-key-wedge-repro.mjs` before concluding
anything.**

On macOS, headless=new Chrome has a machine-state-dependent input pipeline
pathology: after roughly 6 to 10 bare modifier-key `Input.dispatchKeyEvent` calls
(Shift down/up pairs, for instance) the renderer wedges, and every subsequent
`Runtime.evaluate` and `Browser.grantPermissions` stops returning, sometimes
recovering after about 10 seconds and sometimes not. The repro script is 30 lines
of bare CDP with no SDK involved. If it wedges, the machine is the problem and a
reboot usually fixes it; if it does not wedge and the tests are still red, that is
a real regression.

Ruled out, so do not re-investigate: CPU pressure alone (eight `yes` processes)
does not reproduce it; spacing events 30 or 60ms apart makes no difference, since
it accumulates by count rather than rate; `--disable-ipc-flooding-protection`,
`--single-process` and `--disable-gpu` all fail to help; on a healthy machine the
same suite passes 49 of 49 in about 15 seconds.

Contributing factors, strongest first: a machine that has not been rebooted in a
long time, other files having run earlier in the same vitest invocation, and a JS
dialog having just been dismissed by `Page.handleJavaScriptDialog`. The first key
burst after a dialog reliably stalls for about 10 seconds, which is why the dialog
tests are pinned to the end of the file. Do not move them.

Test infrastructure worth keeping: the three files that spawn a real Chrome
(`sdk-locator-real`, `playwright-injected`, `switchover.e2e`) exclude each other
through the cross-process mutex in `chrome-e2e-lock.ts`; all of them use
`--remote-debugging-port=0` with `DevToolsActivePort`, which makes them immune to
colliding with a leaked instance (a fixed random port once hit a leaked Chrome and
presented as inexplicable cascading timeouts); and every teardown has a SIGKILL
backstop and waits for Chrome to actually exit.

## The model-facing shape: only what the documentation promises

```
Browser own: [browserId, capabilities, tabs, user]
Tab     own: [id, playwright, dom_cua, cua, content, clipboard, dev, capabilities]
```

No internal fields. Not `conn` (the raw transport), not injection state, not `cdp`
or `evaluateOrThrow`.

This matters in practice rather than in principle. An agent holding a tab runs
`getOwnPropertyNames(getPrototypeOf(tab))` to see what is there. An internal
`evaluateOrThrow` that leaked out was picked up and used as API, bypassing every
check we had and breaking the moment it was renamed.

TypeScript's `private` is compile-time only. At runtime it is an ordinary
property, and enumeration still finds it.

How the hiding is done — read this before changing `sdk/`:

| mechanism | used for | why |
|---|---|---|
| WeakMap (`tabCore(tab)`, `browserConnections`) | Tab internal state, Browser connections | internal code in other modules has to read it, and a `#` field cannot leave its class |
| Module-level functions (`cdp(tab, …)`, `injectPlaywright(tab)`, `attachTarget(tab, …)`) | internals shared across modules | on no prototype, so nothing can enumerate them, while an `import` in the package reaches them |
| `#` private fields and methods | `Browser#info`, `Tabs#conn`, `Locator#tab`, `Tab.#enableDomains` | no cross-module need, so no reason to go through a WeakMap |

The dependency direction is one-way: internals <- playwright/cua <- index.
`internals.ts` imports nothing above it, which is what keeps the cycle from
returning.

## Capabilities that are deliberately not advertised

These are gated by `getInfo().capabilities.tab`. The operon backend does not
declare them, so the client never offers the model an entry point that cannot
work:

- **webMcp** (MCP tools embedded in a page): out of scope.
- **browserAuth**: handing credential entry back to the user when an agent hits a
  login wall, with the user typing into a trusted form in the host application so
  the value never enters the model's context. Not declared, and its documentation
  is not bundled into the product runtime.
- **Raw CDP**: not advertised. The production runtime does not export the
  transport, which stops a model routing around the origin, file-transfer and
  history approvals. Internally the SDK issues only the fixed CDP calls its public
  API needs.

If browserAuth is ever picked up, the design is: the client connects to a host
broker over `nodeRepl.nativePipe.createConnection(env.BROWSER_AUTH_BROKER_SOCKET_PATH)`,
using the same framing as `wire.ts` (a 4-byte native-endian length prefix plus
JSON, capped at 128KB per frame), with five messages:

| direction | message |
|---|---|
| client to broker | `{type:"register", expires_at, fields}` — field metadata only, no values |
| broker to client | `{type:"registered", challenge_id}` — a random id matching `/^[A-Za-z0-9_-]{32,128}$/` |
| broker to client | `{type:"submission", challenge_id, fields:{id: value}}` after the user submits |
| client to broker | `{type:"result", challenge_id, status}` once the client has filled the page |
| broker to client | `{type:"completed", challenge_id, status}` as confirmation; a decline or timeout is sent directly by the broker |

Statuses: `submitted`, `declined`, `cancelled`, `unavailable`, `expired`,
`origin_changed`, `page_changed`, `locator_invalid`, `submission_failed`.

The credential prompt would be a trusted window in the Electron renderer, never an
injected page: origin, reason, field list, masked password, a five-minute
countdown and a Decline button. The rule for the values is absolute: no logging,
never through the server chat flow, and never touching any model-visible surface.

## Testing strategy: the reference client as an oracle

The iab-oracle suite has the vendored reference client discover and drive our
backend. It is the authoritative implementation of the wire contract, so it
working proves the backend is correct, and it failing means the bug is ours.
Unit tests that build and parse their own frames (`wire.test.ts`) can only prove
self-consistency, never interoperability.

Verified against it: discovery, framing, the getInfo schema, echo mode, subagents,
CDP and navigation, ordinary and full-page screenshots, and the complete locator
and runtime path. Additional backend contract tests cover targets, download
notifications, capabilities, turnEnded, cached expressions, and bootstrapping a
navigation with no tab.

## One backend is enough (echo mode)

The client actively closes any IAB backend whose session or build flavour does not
match; extension and cdp backends take no part in either filter. The discovery
contract and the reasons for our test adaptations are recorded in
[`docs/legacy-oracle-discovery.md`](docs/legacy-oracle-discovery.md).

That looks like it forces one backend per session. It does not: `getInfo` is
itself a session request, carrying the asker's `{session_id, turn_id,
session_context}` in its params, so the backend can echo that session id straight
back and match every session. Every subsequent RPC carries `session_id` too, which
is how one backend divides tab ownership internally.

```ts
new IabBackend({ driver })            // no sessionId means echo mode (recommended)
new IabBackend({ driver, sessionId }) // pinned to one session (rarely needed)
```

## Architecture

```
model -> node_repl (the kernel from @operon/computer-use) -> import the browser client
  -> agent.browsers.get("iab" | "extension")
  -> tab.playwright.* / tab.cua.*
  -> nodeRepl.nativePipe -> readdir /tmp/operon-browser-use/ -> connect to each
     -> getInfo() -> filter by type
       |- type "iab"       -> our IabBackend -> webContents.debugger (CDP) -> the operon browser
       |- type "extension" -> our TypeScript host -> Native Messaging -> the extension
                              -> chrome.debugger (CDP)
```

Both paths put their sockets in the same private directory,
`/tmp/operon-browser-use/<id>.sock`, and are told apart by `getInfo().type`, never
by path.

Above the waist — socket, framing, getInfo, the RPC methods — the two paths are
identical and share `wire.ts` and `JsonRpcPeer.ts`. They differ only in the driver
below it.

The IAB browser is the one the user can see (`src/components/browser/`), not a
hidden instance. What separates it from the extension path is *whose* signed-in
sessions are in play: the in-app browser's own, or the user's existing Chrome
profile. Visibility is a capability switch
(`browser.capabilities.get("visibility").set(bool)`), backed by operon's
`BrowserManager.setVisible()`.

All tabs share one persistent profile, `persist:operon-browser`, and cross-tab
cookies are verified against the real app. The cleanup menu is explicit about it:
`Clear browser cookies/cache`. The older per-tab partitions are no longer mounted,
so signed-in state from before that change does not migrate automatically.

Platform: macOS only for now. A Windows native host would go through the registry
with an `.exe` rather than the shell wrapper used on macOS, and needs its own
design.

## Runtime prerequisite

The browser client requires `session_id` and `turn_id` inside
`nodeRepl.requestMeta["x-codex-turn-metadata"]`, and throws
`Missing required browser session_id` on its very first call without them. This is
implemented in `@operon/computer-use`:

```ts
// Pass this every turn. The kernel outlives a turn, so omitting it leaves the
// previous turn_id in place.
await session.run(code, { session_id, turn_id })

// A subagent: with thread_source "subagent", thread_id replaces session_id.
await session.run(code, { session_id, turn_id, thread_source: "subagent", thread_id })
```

Points worth knowing:

- The value is an object, not a JSON string, and consumers do not parse it. The
  `requestMeta` type is therefore `Record<string, unknown>` rather than
  `Record<string, string>`.
- The subagent case gives a subagent its own browser session, with its own tab
  ownership and leases.
- Turn metadata has to be updatable, which is what `HostSetRequestMeta` is for.
  The kernel outlives a turn while turn_id changes every turn, so relying on the
  KernelInit passed at fork time would freeze it at the first turn.
- The façade supplies `tmpDir`, `homeDir` and `cwd`, and deliberately supplies no
  `telemetry`, which is optional throughout. Only `tmpDir` is genuinely required,
  because the read tests whether `nodeRepl` exists rather than whether `tmpDir`
  does.

This is not browser-specific. The Computer Use client reads the same key but
tolerates its absence, sending null, which the server accepts. The browser client
does not tolerate it, and the reason is resource ownership: the browser leases
persistent resources the user owns — real tabs — and has to be able to hand them
back. Computer Use operates a desktop without taking possession of a window.

Tests: `packages/computer-use/turn-metadata.test.ts` reads the values inside the
kernel the same way a consumer would, so the tests go red when the contract drifts
rather than when the implementation is refactored.
