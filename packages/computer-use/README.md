# @operon/computer-use — the node_repl runtime

> **On the oracle and differential suites.** Notes in this package point at recordings made
> against a reference client. Those suites are not in this repository: they run our
> implementation side by side with a third-party client that is not ours to redistribute, so
> without it there is no yardstick and nothing to run. Put the reference in place locally and
> they work. What they guard still holds — the frame shapes came from recording real traffic
> rather than from reading a minified bundle, and that distinction is the whole point.


A self-contained module that gives a model a persistent `node_repl` JavaScript
session, a privileged `globalThis.nodeRepl` surface, and a Computer Use client
(`computer/`) that drives the `operon-computer-use` Swift engine to control macOS
applications.

## Naming

The model-facing global is `computer` (`computer.click(...)`), and the directory
is `computer/`, matching the Computer Use feature in the product.

Some wire-level names keep an older spelling on purpose: the `skyshot` field,
`ComputerUseIPCAppGetSkyshotRequest`, `SKY_CUA_NATIVE_PIPE_PATH`. Those are the
shapes the contract is defined in, and the sky-wire-oracle recordings validate them
against a recorded oracle. Renaming them would throw away the comparability the
tests depend on.

## The client is ours; the vendored copy is a test oracle only

What the model sees as `computer.*` comes from `computer/`, written in
TypeScript. It used to be a vendored bundle, which was proprietary and could not
be redistributed with a product.

The acceptance criterion for replacing it was differential testing, not
confidence: the sky-differential suite runs both implementations through the same
sequence of calls against the same recording server and requires zero difference
across 50 frames, with matching return values. That establishes the wire and
client contract. The Swift side — accessibility, background launching, focus
behaviour — is covered by native tests and on-device smoke runs, and cannot be
substituted by frame comparison.

`vendor/oai-sky` therefore must not be deleted: removing it removes the baseline
the client contract is checked against. It is gitignored and never ships.

```
computer/wire.ts     Framing (4-byte LE uint32 + UTF-8 JSON), JSON-RPC, a
                     long-lived transport, and the ping handshake
computer/client.ts   Low-level Mac client: requestType dispatch and action
                     encoding, with every shape taken from recordings
computer/index.ts    Public window API: validate, apply policy, ask for
                     approval, substitute appPath, map the response
```

### Read this before changing the wire

The shapes here were established by recording real traffic, and guessing them
went badly wrong once while every test stayed green. `WireTests.swift` compared
hand-written expected JSON against its own encoder and decoder, and all three
agreed on two wrong fields:

| field | actual | previously assumed |
|---|---|---|
| `elementID` (setValue, selectText and others) | `"5"`, a String | `5`, an Int |
| `mouseButton` | `0`/`1`/`2`, an Int | `"left"`, a String |

The result was that every click and every element-index action failed to decode
at the wire layer. The only e2e test exercised `list_apps()`, so none of it ever
surfaced.

Do not hand-write expectations. Run the sky-wire-oracle suite and let it record the traffic
afresh.

## Background control on macOS

The goal is that Computer Use can drive an application while the user keeps
working in another one.

- Applications are launched with `NSWorkspace.OpenConfiguration.activates =
  false`, and neither workspace `activate` nor `AXRaise` is called. For the
  sparse background accessibility trees Electron produces, the service maintains
  accessibility enablement, internal focus and synthetic focus notifications
  within the target PID only, and never changes the system's frontmost app.
- One long-lived `AccessibilitySession` is reused per PID, keeping the
  application and window AX objects and their observers. It prefers a visible
  main CGWindow at bootstrap and binds the AXWindow by frame afterwards. For
  Electron it re-fetches the currently mounted renderer subtree even when an
  `AXWebArea` has already been published. It never picks a conversation on the
  user's behalf.
- **Click**: `prepareToInteract`, then `ClickActivationGate` (Catalyst,
  selection, focused-window, web, coordinates), then either a synthesised
  `sendClick(MouseEventTarget, flipped)` for web and `alwaysSimulateClick`, or
  `AXPress` for native controls. `OPEN_COMPUTER_USE_ALWAYS_SIMULATE_CLICK=1`
  forces the synthetic path.
- **Focus preventer**: `SystemFocusStealPreventer` paired with its enforcer,
  using per-pid mouse taps, a ViewBridge keyboard tap, and menu-dismissal
  suppression.
- **Activation**: `appActivated` plus a mouseMoved to the window centre, with no
  down or up.
- **set_value**: search fields autosubmit with Return.
- **scroll**: a direction and page count map to internal deltaX/deltaY.
- **PiP**: an SCStream IOSurface is submitted directly to a remote `CAContext`,
  and Electron's native `CALayerHost` receives only a `contextID` and mounts the
  remote layer. A single fallback frame goes to the same context, so nothing
  passes through per-frame image encoding, stdout, base64 or temporary files.
- Every action refreshes the snapshot first and re-resolves the element by AX
  object, identifier, and role/title/frame. When the UI has changed and the
  element cannot be uniquely re-resolved, a fresh-state error is returned rather
  than acting on a stale `element_index`.
- `FocusStealGuard` is a compatibility backstop: if an application brings itself
  to the front during launch or an action, the previously active application is
  restored before the tool returns. If the user deliberately clicks into the
  target, it does not fight them for focus.
- Typing in another application does not abort Computer Use. Only a keyboard
  event delivered while the controlled app is frontmost, or a pointer event
  landing inside its window, counts as the user taking over.
- Takeover returns `-10016`: callers wait out a backoff and must then call
  `get_app_state` again. `Stop Computer Use for <App>` in the menu bar ends the
  current turn explicitly and returns `-10012`. A locked screen returns `-10020`.
- The Swift accessory service creates its menu bar item only for the duration of
  an active session, showing the target app and Stop, and removes it as soon as
  the session ends.
- PiP is mounted as a native child view of the main window with click-through.
  The renderer reports the current conversation area continuously, and the native
  host lays the preview out in that area's top-right corner, re-laying out as the
  sidebar or window changes. The `file://` screenshots the model receives are a
  separate path from this preview.

An on-device background smoke test launches System Settings, reads real
accessibility data and screenshots, and asserts the frontmost application never
changed:

```bash
OPERON_RUN_COMPUTER_USE_DESKTOP_SMOKE=1 \
  npx vitest run packages/computer-use/desktop-background.e2e.test.ts
```

The Electron smoke test targets a chat application, selects a conversation
explicitly, and verifies the renderer subtree, the refetch before each action,
and that the frontmost app is unchanged. It is opt-in, needs the Mac unlocked,
and the target must not already be frontmost:

```bash
OPERON_RUN_COMPUTER_USE_ELECTRON_SMOKE=1 \
  npx vitest run packages/computer-use/desktop-electron.e2e.test.ts
```

### Controlled end-to-end tests, with no access to real application data

There are separate fixtures for AppKit and for Electron. The tests call the
public `computer.*` API from the same persistent `node_repl` a model uses, through
approval, app policy, the wire, and the Swift accessibility and input engine, and
verify the outcome against the fixture's own state file. They open no real
applications and read no user data. The Electron fixture is copied to a temporary
bundle id at runtime, so it cannot connect to a development build by mistake.

```bash
npm run test:computer-use:e2e
```

The suite also asserts the controlled target never became frontmost. All ten
public `computer.*` capabilities have real passing background cases on both the
AppKit and Chromium fixtures, with no `it.fails` gaps.

Five cases were once recorded as known gaps and are all resolved:

- Background scroll and Chromium background `press_key`: our own CPS
  notification tap was active, which made events posted with `CGEventPostToPid`
  lose their in-window position. Making it passive fixed both.
- Native AppKit background `press_key`, and `type_text` after a click: a
  background click does not change AppKit's firstResponder, so focus has to be
  written through accessibility first.
- `type_text` after `set_value`: not a defect. `type_text` appends, and the test
  asserted the wrong thing.

### Screenshots

Screenshots are encoded as JPEG at `screenshotJPEGCompressionQuality = 0.8`.
Measured on the same window, PNG came to 189KB and JPEG to 104KB, 45% smaller.

Note what that saves: transport bytes. A vision model's image token count is
decided by pixel dimensions, so reducing tokens means adjusting
`screenshotResultMaxDimension` (currently 1280), not the encoding.

`get_app_state` used to return `screenshot: null` for any web or Electron
application whose accessibility tree was already hydrated. The first call
deliberately skipped the screenshot to wait for settle, and settle returned early
for a hydrated tree, so nothing ever captured. The Electron suite now asserts
against that regression.

**A Screen Recording TCC record is keyed by binary path.** A bad record on one
path makes ScreenCaptureKit never call back and never report an error, which
looks exactly like a product bug: no screenshots, and every call sitting out its
full five-second timeout. The fixture suite therefore starts its service from a
copy in a temporary directory. If screenshots come back null and slow during
development, move the binary to a different path and try again before suspecting
the code.

## Zero coupling to any framework

This module imports no operon or agent-runtime code. Its dependencies are
`node:*` builtins, `zod` (in the tool adapter only), its own `computer/`, and the
external Swift binary from `native/computer-use`. Everything host-specific —
confirmation, output, images, launching applications — is injected through
`ComputerUseIntegration`.

## Option 1: as an MCP server (recommended)

node_repl is itself an MCP server exposing a single `js` tool, which the model
sees as `mcp__node_repl__js`. A host adds one stdio server to `mcp.json` and needs
no changes to its own tool system:

```json
{
  "mcpServers": {
    "node_repl": {
      "command": "node",
      "args": ["--import", "tsx", "<pkg>/adapters/mcp-server.ts"],
      "env": { "OPERON_CU_BINARY": "<path to operon-computer-use>" }
    }
  }
}
```

The model can then call `tools/call js { source, description }`, where
`description` is a few words used as a live UI title.

**The synchronous display stream**: during a single `tools/call`, text from
`nodeRepl.write`, screenshots from `nodeRepl.emitImage`, and the `description`
title are all pushed to the client through `notifications/message`
(`params.data.type` is `text`, `image` — a data URL or base64 — or `title`),
without waiting for the tool to return. A host that renders those notifications
gets a live stream.

Elicitation is bridged to MCP's `elicitation/create`: a host that supports it
shows an approval prompt, and one that does not simply proceeds. For production,
pre-bundle `mcp-server.ts` to `.mjs` and run it with plain `node`.

## Option 2: embed it directly

```ts
import { createComputerUse } from "@operon/computer-use";

// 1) Provide the integration hooks. All are optional.
const cu = await createComputerUse({
  integration: {
    requestElicitation: async ({ message }) => myAuthorize(message), // your approval UI
    onOutput: (text) => stream.write(text),                          // nodeRepl.write
    onImage: (img) => stream.image(img),                             // nodeRepl.emitImage
    // launchApplication: async (target) => …                        // optional
  },
  // service: { binaryPath, socketPath, autoStart }                  // optional; starts automatically
});

// 2) Register the tool with your agent, or wrap cu.createSession() yourself.
myFramework.registerTool(cu.tool); // { name: "node_repl_js", inputSchema: { code }, execute }

// 3) Tear down.
await cu.dispose();
```

One persistent session per conversation, via `cu.createSession()`. `cu.tool` uses
a default session.

## Public API

| export | purpose |
|---|---|
| `createComputerUse(opts)` | Top-level factory: starts the service, creates a session, returns a tool. The recommended entry point. |
| `ComputerUseIntegration` | The host integration contract (requestElicitation, onOutput, onImage, launchApplication). |
| `ComputerUseService` | Swift service lifecycle: spawn, socket, stop. |
| `NodeReplSession` | A persistent session; `run(code)` returns `{result, output, images}`. |
| `NodeReplHost` | The low level: kernel child process plus the privileged nodeRepl surface. One host can serve many conversations — see "One kernel, many contexts". |
| `createNodeReplTool` | The zod tool adapter. Optional; the core does not depend on zod. |

## Layout

```
integration.ts         Host integration contract, framework-agnostic
createComputerUse.ts   Top-level factory
ComputerUseService.ts  Swift service lifecycle
NodeReplSession.ts     Persistent session
NodeReplHost.ts        Host side: the parent process holding socket, launch and elicitation
ipc.ts                 host <-> kernel message protocol
kernel/entry.ts        Kernel child process: a vm context per conversation, process denied
kernel/facade.ts       The globalThis.nodeRepl surface
banner.ts              Runtime setup run once per kernel, before the model's first line
adapters/tool.ts       zod tool adapter, plus the per-surface `js` description and output clamp
adapters/mcp.ts        MCP server adapter: node_repl as an MCP server with `js` and `js_reset`
adapters/mcp-server.ts Executable stdio entry point, referenced from mcp.json
skill/                 The Computer Use skill (SKILL.md, node-repl.md)
runtime.ts             Idempotent setupComputerUseRuntime bootstrap
package.json           @operon/computer-use (workspace package; deps: zod)
```

## External artefacts

**The Swift engine**, `native/computer-use`: a standalone SwiftPM package built on
an MIT-licensed engine with our own wire layer. `swift build` produces
`operon-computer-use`. `ComputerUseService` looks for the debug build by default;
production passes `binaryPath`.

## Development and production

The kernel child process runs TypeScript through `--import tsx` by default. For
production, pre-bundle `kernel/entry.ts` to `.mjs` and point at it with
`createComputerUse({ kernelEntry, execArgv: [] })`. Under Electron you also have
to handle `ELECTRON_RUN_AS_NODE`.

## The sandbox

Model code runs in `vm.createContext` with `process` denied. Privileged
operations — sockets, launching, elicitation — go to the host over IPC, and the
kernel holds no raw system handles. Genuinely dangerous actions are gated by
`requestElicitation` reaching the host's authorization flow.

This is a soft sandbox, not `isolated-vm` and not an OS seatbelt. Model code can
reach the filesystem through `node:fs`, with the privileges of the host process.

## One kernel, many contexts

A `NodeReplSession` is one conversation. Give it a `host` and it takes a vm
context in that kernel; leave `host` out and it forks a kernel of its own.

The split follows the cost. Measured on an M-series Mac: a kernel process is
~63 MB and ~115 ms of fork plus tsx startup, while `vm.createContext` is ~0.2 MB
and ~190 µs. What a conversation actually needs is its own `globalThis`, which
is the cheap half — so operon shares the process and not the contexts. Six
sessions went from six processes, ~380 MB and ~756 ms to one process, ~90 MB and
~147 ms, with only the first paying the fork.

Isolation is unchanged: contexts do not share globals, so one conversation
cannot see another's variables.

What the sharing does require is that **everything leaving the kernel names the
context that caused it**. Trusted modules are cached per process — the browser
SDK is a single module instance shared by every context, and it finds its
session through `globalThis.nodeRepl.requestMeta` — so a plain field would hand
whichever conversation wrote last to all of them, and `session_id` is the
backend's tab-lease and ownership key. `kernel/entry.ts` therefore keeps the
executing context in an `AsyncLocalStorage`: `send` tags each outbound request
with it, `requestMeta` is a getter that resolves through it, and the façade
captures and re-enters it for socket handlers, which fire outside any execution.
`node-repl-multiplex.test.ts` pins this, including under interleaved execution.

Codex reaches the same conclusion about the ALS and stops one step earlier: its
kernel is spawned inside an OS sandbox (`sandbox-exec` / Landlock) bound to one
conversation's `sandboxCwd` and permission profile, so a second context would
still need a second process — hence its `sandbox_changed` → "kernel reset, rerun
your request" path. We put no OS sandbox on the kernel, so the process boundary
carries no isolation we lose by sharing it. Adding one later would make this
design invalid, not merely slower.

## Open: a virtual cursor

Both Browser Use paths, the in-app browser and the Chrome extension, draw a
virtual cursor. Computer Use does not, and it should.

The argument that it is unnecessary because Computer Use drives a real desktop
where the system pointer is already visible does not hold. The default input path
is `InputSimulation.clickTargeted` (`ComputerUseService.swift`, around line 1770),
which posts through `CGEvent.postToPid(pid)` **directly to the target process
without moving the physical pointer at all**. `clickGlobally`, which does move the
real pointer, is only a fallback behind an environment switch
(`globalPointerFallbacksEnabled`).

So by default the user cannot tell which control the agent is operating. It is
the same problem as synthetic CDP events not moving the mouse in a browser, and
it needs the same answer. If anything a virtual cursor matters more here than it
does in a browser.

What is worth building: a simple arrow drawn above the target application, a
smooth movement animation, and hiding it as soon as the user takes over. The
cursor should be drawn on the Swift side and its position mirrored into the
remote `CAContext` cursor layer, so the target window and the PiP preview beside
the conversation show the same pointer state. Electron then needs neither a
transparent preview window nor per-frame screenshots; it only anchors the
`CALayerHost` to the current conversation area.
