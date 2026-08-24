/**
 * node_repl MCP server: a JavaScript kernel the model drives Computer Use and
 * Browser Use from.
 *
 *   `await import(OPERON_BROWSER_CLIENT_PATH)` -> `setupBrowserRuntime({globals: globalThis})`
 *   -> `agent.browsers.get("iab")` -> the main process's IabBackend, found over a socket
 *
 * ## Why one route per session rather than a single shared server
 *
 * The kernel keeps `globalThis` alive across turns, which is exactly how
 * `agent.browsers` gets reused. Two conversations sharing one kernel would
 * therefore see each other's variables. So each sessionId gets its own
 * `NodeReplSession`, meaning its own kernel child process. The route itself is
 * shared and reads identity from the URL, the same shape as workspace-chat,
 * task-board and memory (`mcp-config.ts` bakes identity into the URL).
 *
 * ## Why identity comes from the URL rather than from request metadata
 *
 * A kernel configured statically cannot know which session it belongs to, and
 * has to be told on every request through `_meta["x-codex-turn-metadata"]`.
 * Operon computes `mcpServers` per session in the host instead, so identity can
 * be baked into the URL at mount time. A client that does send `_meta` still
 * wins; for everyone else this route synthesises it from the URL.
 *
 * turn_id is synthesised here too. The IAB backend never consumes it (its
 * `trackTurnEnded` is always false), so it is just an opaque token flowing back
 * to our own backend. If a client does supply `_meta`, the
 * `@operon/computer-use` adapter prefers that.
 *
 * Mounted at `/api/node-repl-mcp?sessionId=<id>` (see app.ts).
 */

import { Hono, type Context } from 'hono'
import {
  buildNodeReplMcpServer,
  createTomlConfigStore,
  ComputerUseService,
  OPERON_COMPUTER_USE_CLIENT_PATH_ENV,
} from '@operon/computer-use'
import {
  OPERON_BUILD_FLAVOR,
  BUILD_FLAVOR_ENV,
  OPERON_BROWSER_CLIENT_PATH_ENV,
} from '@operon/browser-use'
import { OPERON_SITE_ADAPTERS_PATH_ENV } from '@operon/site-adapters'
import { createRuntimeLogger } from '@operon/agent-runtime'
import {
  serveMcpStatefulOverHono,
  type StatefulMcpTransportHolder,
} from './mcp-http.js'
import { getBrowserUseConfig } from '../services/browser-use-config.js'
import { getComputerUseConfig } from '../services/computer-use-config.js'
import { getChromeUseConfig } from '../services/chrome-use-config.js'
import { requestOperonElicitation } from '../services/ai/host-elicitation.js'
import {
  publishComputerUsePresentationEvent,
  setComputerUseEndHostSessionHandler,
  setComputerUseServiceStopHandler,
} from '../services/computer-use-presentation.js'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const logger = createRuntimeLogger('node-repl-mcp')

/** Locate the workspace package in development; packaged builds use operon-runtime. */
const BROWSER_USE_PKG_DIR = (() => {
  try {
    const req = createRequire(import.meta.url)
    return path.dirname(req.resolve('@operon/browser-use'))
  } catch {
    return ''
  }
})()

const PACKAGED_RUNTIME_DIR = (() => {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (!resourcesPath) return ''
  const candidate = path.join(resourcesPath, 'operon-runtime')
  return existsSync(candidate) ? candidate : ''
})()
/**
 * Entry point for the browser SDK the model sees. The skill does
 * `await import(OPERON_BROWSER_CLIENT_PATH)` and then calls
 * `setupBrowserRuntime({ globals: globalThis })`.
 *
 * Since 2026-07-17 this resolves to our own `@operon/browser-use/sdk`. What it
 * had to satisfy before that switch:
 *
 * - Frame-by-frame differential testing (the sdk-differential suite): the wire
 *   method set, the session triple, the CDP sequence a `goto` emits, and the
 *   commandParams of every individual CDP call all had to match.
 * - End-to-end against real Chrome (`sdk-locator-real.test.ts`): click, fill,
 *   actionability, hit testing, same-origin nested iframes and cross-origin
 *   OOPIFs, each mutation-verified.
 *
 * The differential tests still run against the oracle fixtures in this repo,
 * but the production route has no vendored fallback.
 */
const BROWSER_CLIENT_PATH = (() => {
  if (PACKAGED_RUNTIME_DIR) return path.join(PACKAGED_RUNTIME_DIR, 'browser-client.js')
  return BROWSER_USE_PKG_DIR ? path.join(BROWSER_USE_PKG_DIR, 'sdk', 'runtime.ts') : ''
})()

/** Site adapters package root — trusted import + env path for agent skills. */
const SITE_ADAPTERS_DIR = (() => {
  try {
    const req = createRequire(import.meta.url)
    return path.dirname(req.resolve('@operon/site-adapters'))
  } catch {
    return ''
  }
})()
const SITE_ADAPTERS_ENTRY = PACKAGED_RUNTIME_DIR
  ? path.join(PACKAGED_RUNTIME_DIR, 'site-adapters.js')
  : SITE_ADAPTERS_DIR
    ? path.join(SITE_ADAPTERS_DIR, 'index.ts')
    : ''

/**
 * `@operon/computer-use` is bundled into Electron's main chunk, so relative
 * `new URL(..., import.meta.url)` expressions inside that package are rewritten
 * by Rollup to `data:` assets. Those cannot be passed to `fileURLToPath`.
 *
 * Resolve the workspace package through Node instead and pass concrete file
 * paths into the bundled package. Packaged builds use the prepared runtime
 * directory and never depend on workspace source paths.
 */
const COMPUTER_USE_PKG_DIR = (() => {
  if (PACKAGED_RUNTIME_DIR) return ''
  try {
    const req = createRequire(import.meta.url)
    return path.dirname(req.resolve('@operon/computer-use'))
  } catch {
    return ''
  }
})()

/** Model-side Computer Use bootstrap used by the Codex-aligned managed skill. */
const COMPUTER_USE_CLIENT_PATH = PACKAGED_RUNTIME_DIR
  ? path.join(PACKAGED_RUNTIME_DIR, 'computer-use-client.js')
  : COMPUTER_USE_PKG_DIR
    ? path.join(COMPUTER_USE_PKG_DIR, 'runtime.ts')
    : ''

/** Colon/semicolon-joined absolute dirs the kernel may import (codex-compatible). */
/**
 * The kernel's import allowlist (`assertTrustedImport`). Only modules under
 * these directories can be `await import()`ed into the trusted realm and reach
 * the full nodeRepl, nativePipe included.
 *
 * The SDK's own package directory has to be on this list. Leave it off and the
 * skill's `await import(OPERON_BROWSER_CLIENT_PATH)` is rejected by the
 * allowlist, which reports "untrusted" rather than "not found" and is very easy
 * to misread.
 */
function trustedModuleSha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const TRUSTED_MODULE_SHA256S = [
  BROWSER_CLIENT_PATH,
  COMPUTER_USE_CLIENT_PATH,
  SITE_ADAPTERS_ENTRY,
]
  .filter((file) => file && existsSync(file))
  .map(trustedModuleSha256)
  .join(',')

const KERNEL_ENTRY = PACKAGED_RUNTIME_DIR
  ? path.join(PACKAGED_RUNTIME_DIR, 'node-repl-kernel.js')
  : COMPUTER_USE_PKG_DIR
    ? path.join(COMPUTER_USE_PKG_DIR, 'kernel', 'entry.ts')
    : undefined
const COMPUTER_USE_BINARY = PACKAGED_RUNTIME_DIR
  ? path.join(PACKAGED_RUNTIME_DIR, 'operon-computer-use')
  : COMPUTER_USE_PKG_DIR
    ? path.resolve(
        COMPUTER_USE_PKG_DIR,
        '..',
        '..',
        'native',
        'computer-use',
        '.build',
        'debug',
        'operon-computer-use',
      )
    : undefined
const KERNEL_EXEC_ARGV = PACKAGED_RUNTIME_DIR
  ? ['--experimental-vm-modules']
  : ['--import', 'tsx', '--experimental-vm-modules']

interface Entry extends StatefulMcpTransportHolder {
  server: Awaited<ReturnType<typeof buildNodeReplMcpServer>>['server']
  dispose: () => Promise<void>
  lastUsed: number
  /**
   * The stateful MCP transport for this session's current client.
   *
   * It has to stay alive for as long as the client does: every cross-origin
   * navigation in Browser Use raises an `elicitation/create` to ask the user,
   * and that is a server-to-client request, which can only be delivered over
   * the client's GET SSE stream. When the Grok runtime rebuilds, only the
   * transport is replaced; the Entry and its kernel-backed server survive.
   * See serveMcpStatefulOverHono in mcp-http.ts.
   */
}

/** sessionId -> that session's node_repl, one kernel child process each. */
const bySession = new Map<string, Entry>()

/**
 * Sessions currently being created. This map is load-bearing: an MCP client's
 * `connect()` sends the initialize POST and opens the GET SSE stream almost
 * simultaneously, and with no entry in `bySession` yet both requests would fork
 * their own kernel child process. The second would then evict the first from
 * the map, leaving an orphan process nothing can reach. Building a kernel is
 * async and slow (fork plus tsx startup), so that window is easy to hit.
 */
const inFlight = new Map<string, Promise<Entry>>()

/** How long a session's kernel may idle before it is reclaimed. It is a
 *  long-lived child process, so they cannot be allowed to accumulate. */
const IDLE_MS = 30 * 60 * 1000

/**
 * The shared Swift Computer Use engine that backs `computer.*`. Exactly one
 * per process.
 *
 * It cannot be per-session. ComputerUseService defaults its socketPath to
 * `/tmp/opcu-<pid>.sock`, which every session in the same process computes
 * identically, so N sessions would mean N Swift processes fighting over one
 * socket. The kernel only needs `SKY_CUA_NATIVE_PIPE_PATH` to point at a live
 * socket, and one is enough to serve every session.
 */
let computerUseService: ComputerUseService | null = null

/**
 * Make sure the engine is running if the toggle says so, and return the
 * socketPath the kernel should connect to. Null when it is off or failed to start.
 *
 * A failure to start is deliberately not thrown. The Swift binary only exists
 * after a `swift build`, which a development machine may never have run.
 * Letting Browser Use keep working, and giving the model a clear error only
 * when it actually calls `computer.*`, beats failing to build node_repl at all.
 */
async function ensureComputerUseService(): Promise<string | null> {
  if (!getComputerUseConfig().enabled) return null
  computerUseService ??= new ComputerUseService({
    ...(COMPUTER_USE_BINARY ? { binaryPath: COMPUTER_USE_BINARY } : {}),
    restartDelaysMs: [100, 500, 2_000, 5_000],
    onPresentationEvent: publishComputerUsePresentationEvent,
    // The engine's own diagnostics (TCC denials, capture failures) used to die
    // in a buffer that only an abnormal exit ever printed.
    onStderrLine: (line) => logger.warn(`computer use engine: ${line}`),
    onExit: ({ code, signal, stderr }) => {
      const status = signal ? `signal=${signal}` : `code=${code ?? 'unknown'}`
      logger.warn(`computer use engine exited unexpectedly (${status})${stderr ? `: ${stderr}` : ''}`)
    },
  })
  try {
    // start() also performs a real socket connect. A live child with a dead or
    // stale socket is restarted in place, preserving the path baked into kernels.
    await computerUseService.start()
  } catch (e) {
    logger.warn(`computer use engine unavailable: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  return computerUseService.socketPath
}

/**
 * macOS grants as the engine process sees them, starting it if needed.
 *
 * `running: false` means Computer Use is off (or the binary is missing), which
 * the UI shows differently from "on but not permitted".
 */
export async function getComputerUsePermissions(): Promise<{
  running: boolean
  accessibility: boolean
  screenRecording: boolean
}> {
  const socketPath = await ensureComputerUseService()
  const permissions = socketPath ? await computerUseService?.permissions() : undefined
  if (!permissions) return { running: false, accessibility: false, screenRecording: false }
  return { running: true, ...permissions }
}

/** Open the System Settings pane for a grant (the engine owns the TCC identity). */
export async function openComputerUsePermissionSettings(
  permission: 'accessibility' | 'screenRecording',
): Promise<void> {
  const socketPath = await ensureComputerUseService()
  if (!socketPath || !computerUseService) {
    throw new Error('Computer Use engine is not running')
  }
  await computerUseService.openPermissionSettings(permission)
}

/** Stop the shared engine when Computer Use is switched off. Called by the toggle route. */
export async function stopComputerUseService(): Promise<void> {
  const service = computerUseService
  computerUseService = null
  await service?.stop().catch(() => {})
}

setComputerUseEndHostSessionHandler(async (hostSessionID) => {
  await computerUseService?.endHostSession(hostSessionID)
})
setComputerUseServiceStopHandler(stopComputerUseService)

function sweepIdle() {
  const now = Date.now()
  for (const [id, e] of bySession) {
    if (now - e.lastUsed < IDLE_MS) continue
    bySession.delete(id)
    void e.dispose().catch(() => {})
    logger.info(`disposed idle node_repl session ${id}`)
  }
}

async function entryFor(sessionId: string): Promise<Entry> {
  const existing = bySession.get(sessionId)
  if (existing) {
    existing.lastUsed = Date.now()
    return existing
  }
  const pending = inFlight.get(sessionId)
  if (pending) return await pending
  const p = buildEntry(sessionId).finally(() => inFlight.delete(sessionId))
  inFlight.set(sessionId, p)
  return await p
}

async function buildEntry(sessionId: string): Promise<Entry> {
  // Only start the Swift service when Computer Use is on. With it off, a model
  // calling `computer.*` fails to reach the socket and gets an error, while
  // Browser Use, which does not need it, keeps working.
  const socketPath = await ensureComputerUseService()
  const chatId = Number(sessionId)
  const hostElicitation = Number.isSafeInteger(chatId) && chatId > 0
    ? (request: { message: string; meta?: unknown }) => requestOperonElicitation(chatId, request)
    : undefined
  const built = await buildNodeReplMcpServer({
    // Always `autoStart: false`, even when Computer Use is on. This code path is
    // per-session, and `createComputerUse` would `new ComputerUseService(...)`
    // and start it. That service defaults its socketPath to
    // `/tmp/opcu-<pid>.sock`, one value for the whole process, so a Swift engine
    // per session would fight over a single socket, and whichever session
    // disposed first would `service.stop()` everyone else's engine with it.
    // This module owns one shared service instead; all we pass down here is its
    // socketPath so the kernel can connect. (With autoStart false, `stop()`
    // sees `this.proc == null` and returns without side effects.)
    service: {
      autoStart: false,
      ...(COMPUTER_USE_BINARY ? { binaryPath: COMPUTER_USE_BINARY } : {}),
      ...(socketPath ? { socketPath } : {}),
    },
    ...(KERNEL_ENTRY
      ? { kernelEntry: KERNEL_ENTRY, execArgv: KERNEL_EXEC_ARGV }
      : {}),
    // Env for the kernel *process*. The model never sees it: there is no
    // `process` inside the sandbox. The import allowlist is read from here, and
    // without these entries the model could not even import our own
    // browser-client, since only `node:` builtins are permitted by default.
    processEnv: {
      NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: TRUSTED_MODULE_SHA256S,
    },
    // Startup token for the CU socket, so the kernel host (NodeReplHost) can
    // send an authenticating first frame. It has to be the *shared* engine's
    // token: this module passes autoStart:false so the factory starts nothing,
    // and the process actually enforcing the token is the computerUseService
    // that ensureComputerUseService() started above. Only set when CU is on.
    ...(socketPath && computerUseService
      ? { cuAuthToken: computerUseService.authToken }
      : {}),
    env: {
      // IAB-only selection key. Chrome extension backends deliberately ignore app flavor.
      // Production currently uses "operon"; isolated tests may override it.
      [BUILD_FLAVOR_ENV]: OPERON_BUILD_FLAVOR,
      // The Browser skill is installed into user-level agent directories, while
      // this client ships inside the app. Give the skill the resolved absolute
      // path through the restricted nodeRepl.env instead of baking a machine-
      // specific path into SKILL.md.
      [OPERON_BROWSER_CLIENT_PATH_ENV]: BROWSER_CLIENT_PATH,
      // Codex runs the same idempotent setup guard in every fresh JavaScript
      // session. Keep the installed skill portable by injecting our signed
      // runtime entry instead of writing an absolute path into SKILL.md.
      [OPERON_COMPUTER_USE_CLIENT_PATH_ENV]: COMPUTER_USE_CLIENT_PATH,
      // Site-adapter entry (bilibili.hot, …). Same path injection pattern as the
      // browser client — skills never hard-code install locations.
      [OPERON_SITE_ADAPTERS_PATH_ENV]: SITE_ADAPTERS_ENTRY,
    },
    // Most MCP clients do not know Codex's private per-tool metadata. The route
    // already owns the conversation identity, so make it the standards-based
    // fallback and synthesize the opaque turn id on every js invocation.
    fallbackTurnMetadata: () => ({
      session_id: sessionId,
      turn_id: randomUUID(),
    }),
    turnMetadataAugment: () => ({
      operon_session_id: sessionId,
    }),
    ...(hostElicitation
      ? { integration: { requestElicitation: hostElicitation } }
      : {}),
    // Backend for `nodeRepl.config`: browser security policy plus remembered approvals.
    // Omit it and `tab.goto()` fails with "Browser security unavailable outside
    // node repl": the presence of a config is what tells the SDK it is running
    // inside a node repl at all (see the config comment in kernel/facade.ts).
    // The root is `~/.operon/` rather than any other agent's config directory,
    // because the paths passed down are relative and the host decides the root.
    // Approvals land in `~/.operon/browser/`, the same file the Settings ->
    // Browser page reads and writes.
    configStore: createTomlConfigStore(),
  })
  const entry: Entry = {
    ...built,
    lastUsed: Date.now(),
    // The transport is long-lived now, so reclaiming a session has to close it
    // too, or the SSE stream and its socket leak.
    dispose: async () => {
      await entry.transition?.catch(() => {})
      await entry.transport?.close().catch(() => {})
      await built.dispose()
    },
  }
  bySession.set(sessionId, entry)
  logger.info(`created node_repl session ${sessionId} (${bySession.size} live)`)
  return entry
}

export function nodeReplMcpRoutes() {
  const router = new Hono()
  const handle = async (c: Context) => {
    sweepIdle()
    // Catches the case where the toggle was on when the session was created and
    // has since been turned off. That session's mcpServers were baked long ago,
    // so mcp-config's gating cannot reach back to it and only this check can.
    // The condition is an OR, matching mcp-config: node_repl is the entry point
    // for two features, so it must keep serving while either one is enabled.
    if (
      !getBrowserUseConfig().enabled &&
      !getComputerUseConfig().enabled &&
      !getChromeUseConfig().enabled
    ) {
      return c.json({ error: 'Browser Use and Computer Use are disabled in Settings' }, 403)
    }
    const sessionId = c.req.header('x-session-id') ?? c.req.query('sessionId')
    if (!sessionId) {
      // Without an identity there is no way to pick a kernel, and no way for
      // browser-client to find the right backend.
      return c.json({ error: 'node-repl-mcp requires a sessionId' }, 400)
    }
    // Existing sessions used to bypass ensureComputerUseService entirely. Check
    // on every MCP request so a Swift crash heals before the next computer.* call.
    await ensureComputerUseService()
    const entry = await entryFor(sessionId)
    return serveMcpStatefulOverHono(c, entry.server, entry)
  }
  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)
  return router
}

/**
 * Tear down every kernel child process. Called on process exit and when the
 * feature is switched off.
 *
 * The shared Swift engine goes with them: it is a long-lived child process we
 * spawned too, and clearing only the kernels would leave it running.
 */
export async function disposeAllNodeReplSessions(): Promise<void> {
  const all = [...bySession.values()]
  bySession.clear()
  await Promise.allSettled(all.map((e) => e.dispose()))
  await stopComputerUseService()
}
