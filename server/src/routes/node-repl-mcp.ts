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
 * `agent.browsers` gets reused. Two conversations sharing one JavaScript world
 * would therefore see each other's variables. So each sessionId gets its own
 * `NodeReplSession`, meaning its own vm context. The route itself is shared and
 * reads identity from the URL, the same shape as workspace-chat, task-board and
 * memory (`mcp-config.ts` bakes identity into the URL).
 *
 * The *process* is shared, though: contexts are what isolate conversations, and
 * they are ~0.2 MB against ~63 MB for a kernel process. See sharedNodeReplKernel
 * below and "One kernel, many contexts" in the package README.
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
 * Mounted at `/api/node-repl-mcp?sessionId=<id>` (see app.ts). OpenCode mounts it
 * without a sessionId and tags each call instead; see buildCallerRoutedServer.
 */

import { Hono, type Context } from 'hono'
import {
  buildNodeReplMcpServer,
  listNodeReplTools,
  createTomlConfigStore,
  CuaDriverService,
  CUA_DRIVER_SOCKET_ENV,
  NodeReplHost,
  OPERON_COMPUTER_USE_CLIENT_PATH_ENV,
  type NodeReplSurface,
} from '@operon/computer-use'
import {
  OPERON_BUILD_FLAVOR,
  BUILD_FLAVOR_ENV,
  OPERON_BROWSER_CLIENT_PATH_ENV,
} from '@operon/browser-use'
import { OPERON_SITE_ADAPTERS_PATH_ENV } from '@operon/site-adapters'
import { createRuntimeLogger } from '@operon/agent-runtime'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  serveMcpOverHono,
  serveMcpStatefulOverHono,
  type StatefulMcpTransportHolder,
} from './mcp-http.js'
import { resolveMcpCallerChat, UNKNOWN_CALLER_MESSAGE } from './mcp-caller.js'
import { getBrowserUseConfig } from '../services/browser-use-config.js'
import { getComputerUseConfig } from '../services/computer-use-config.js'
import { getChromeUseConfig } from '../services/chrome-use-config.js'
import { requestOperonElicitation } from '../services/ai/host-elicitation.js'
import { ASSISTANT_NODE_REPL_PREFIX, requestAssistantElicitation } from '../services/assistant/node-repl-bridge.js'
import {
  getComputerUseHostPermissions,
  setComputerUseServiceStopHandler,
  type ComputerUsePermissionKind,
} from '../services/computer-use-lifecycle.js'
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
/**
 * The cua-driver daemon binary.
 *
 * `CuaDriverService` can find it on its own, but only from workspace source:
 * its `defaultBinaryPath()` walks up from `import.meta.url`, and Rollup rewrites
 * that to a `data:` asset when the package is bundled into Electron's main
 * chunk. Passing a concrete path keeps packaged builds off workspace layout
 * entirely.
 */
const CUA_DRIVER_BINARY = PACKAGED_RUNTIME_DIR
  ? path.join(PACKAGED_RUNTIME_DIR, 'cua-driver')
  : COMPUTER_USE_PKG_DIR
    ? path.resolve(COMPUTER_USE_PKG_DIR, '..', '..', 'dist-operon-runtime', 'cua-driver')
    : undefined
const KERNEL_EXEC_ARGV = PACKAGED_RUNTIME_DIR
  ? ['--experimental-vm-modules']
  : ['--import', 'tsx', '--experimental-vm-modules']

type BuiltNodeRepl = Awaited<ReturnType<typeof buildNodeReplMcpServer>>

interface Entry extends StatefulMcpTransportHolder {
  server: BuiltNodeRepl['server']
  callTool: BuiltNodeRepl['callTool']
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

/** sessionId -> that session's node_repl, one vm context each in the shared kernel. */
const bySession = new Map<string, Entry>()

/**
 * Sessions currently being created. This map is load-bearing: an MCP client's
 * `connect()` sends the initialize POST and opens the GET SSE stream almost
 * simultaneously, and with no entry in `bySession` yet both requests would build
 * their own session. The second would then evict the first from the map, leaving
 * an orphan context nothing can reach — and, on the very first session, an
 * orphan kernel process too. Building a session is async (and slow when it is
 * the one that forks the kernel), so that window is easy to hit.
 */
const inFlight = new Map<string, Promise<Entry>>()

/** How long a session's kernel may idle before it is reclaimed. It is a
 *  long-lived child process, so they cannot be allowed to accumulate. */
const IDLE_MS = 30 * 60 * 1000

/**
 * The shared cua-driver daemon that backs `computer.*`. Exactly one per process.
 *
 * It cannot be per-session: the socket path is derived from the pid, so every
 * session in this process computes the same one and N sessions would mean N
 * daemons fighting over it. The kernel only needs the path to point at a live
 * socket, and one daemon is enough to serve every session.
 *
 * Constructed lazily. The Electron dev host starts it when Computer Use is
 * enabled; packaged builds retain their on-demand startup. Constructing is
 * free, so the shared kernel can still be told where the daemon would be while
 * Computer Use is off.
 */
let cuaDriverService: CuaDriverService | null = null

function cuaDriverServiceInstance(): CuaDriverService {
  cuaDriverService ??= new CuaDriverService({
    ...(CUA_DRIVER_BINARY ? { binaryPath: CUA_DRIVER_BINARY } : {}),
    restartDelaysMs: [100, 500, 2_000, 5_000],
    // The agent-cursor overlay is the visible half of this engine; the daemon
    // only parks its main thread in the AppKit run loop that renders it when
    // the overlay is enabled, so leaving it on is not merely cosmetic.
    cursorOverlay: true,
    onStderrLine: (line) => logger.warn(`cua-driver: ${line}`),
    onExit: ({ code, signal, stderr }) => {
      const status = signal ? `signal=${signal}` : `code=${code ?? 'unknown'}`
      logger.warn(`cua-driver exited unexpectedly (${status})${stderr ? `: ${stderr}` : ''}`)
    },
  })
  return cuaDriverService
}

/**
 * Start the daemon if the toggle says so, and return the socket the kernel
 * should use. Null when Computer Use is off or the daemon failed to start.
 *
 * A failure to start is deliberately not thrown, so Browser Use can keep
 * working. Development startup fetches the binary before launching the app;
 * this fallback still covers a damaged or missing binary at runtime.
 */
export async function ensureComputerUseService(): Promise<string | null> {
  if (!getComputerUseConfig().enabled) return null
  const service = cuaDriverServiceInstance()
  try {
    // start() also performs a real socket connect. A live child with a dead or
    // stale socket is restarted in place, preserving the path baked into kernels.
    await service.start()
  } catch (e) {
    logger.warn(`computer use engine unavailable: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  return service.socketPath
}

/**
 * The one kernel process every conversation shares.
 *
 * Before this there was a kernel per chat: ~63 MB and ~115 ms of fork each,
 * with no cap on how many could pile up. What a conversation actually needs is
 * its own `globalThis`, and that is a vm context — ~0.2 MB, ~190 µs — so the
 * process is now shared and the contexts are not. Isolation is unchanged:
 * contexts do not see each other's variables, and every privileged call is
 * tagged with the context that made it so output and approvals reach the right
 * chat.
 *
 * Held behind a getter rather than passed by reference so a kernel that died
 * can be replaced: sessions re-create their context in the new process on their
 * next call instead of staying broken until the app restarts.
 */
let sharedKernel: NodeReplHost | null = null

function sharedNodeReplKernel(): NodeReplHost {
  if (sharedKernel?.alive) return sharedKernel
  // Constructing the service is free and derives the socket path from the pid,
  // so the kernel can be told where the daemon *would* be even while it is off.
  const service = cuaDriverServiceInstance()
  sharedKernel = new NodeReplHost({
    // `nodeRepl.env`, which the model reads. Every entry here is a module-level
    // constant, identical for every conversation, which is what makes one
    // process legitimate in the first place.
    env: {
      // `selectBackend()` reads this to reach the daemon.
      [CUA_DRIVER_SOCKET_ENV]: service.socketPath,
      [BUILD_FLAVOR_ENV]: OPERON_BUILD_FLAVOR,
      [OPERON_BROWSER_CLIENT_PATH_ENV]: BROWSER_CLIENT_PATH,
      [OPERON_COMPUTER_USE_CLIENT_PATH_ENV]: COMPUTER_USE_CLIENT_PATH,
      [OPERON_SITE_ADAPTERS_PATH_ENV]: SITE_ADAPTERS_ENTRY,
    },
    // The kernel process's own env, invisible to the model: the import allowlist.
    processEnv: { NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: TRUSTED_MODULE_SHA256S },
    configStore: createTomlConfigStore(),
    ...(KERNEL_ENTRY ? { kernelEntry: KERNEL_ENTRY, execArgv: KERNEL_EXEC_ARGV } : {}),
    // No `cuSocketPath`/`cuAuthToken`: auth framing was the Swift engine's
    // protocol. cua-driver authenticates by the socket's 0700 directory and
    // would treat the frame as a malformed request.
  })
  logger.info('forked shared node_repl kernel (computer use engine: cua-driver)')
  return sharedKernel
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
  const service = cuaDriverService
  if (!socketPath || !service) return { running: false, accessibility: false, screenRecording: false }
  let permissions = await service.permissions().catch(() => undefined)
  if (!permissions) return { running: false, accessibility: false, screenRecording: false }

  // The daemon caches TCC per process, so a grant made in System Settings while
  // it runs stays invisible to it. When the host already holds a grant the
  // daemon does not report, restart the daemon so it re-reads. Once per host
  // state: if the two keep disagreeing (a stale host read, a dev build with a
  // different identity), the UI's polling must not turn into a restart loop that
  // kills every live session.
  const host = getComputerUseHostPermissions()?.status()
  if (
    host
    && ((host.accessibility && !permissions.accessibility)
      || (host.screenRecording && !permissions.screenRecording))
  ) {
    const key = `${host.accessibility}:${host.screenRecording}`
    if (key !== restartedForHostGrants) {
      restartedForHostGrants = key
      logger.info('host gained a macOS grant the cua-driver daemon does not see; restarting it')
      await service.restart().catch((e) => logger.warn(`cua-driver restart failed: ${e}`))
      permissions = await service.permissions().catch(() => undefined)
      if (!permissions) return { running: false, accessibility: false, screenRecording: false }
    }
  }
  return { running: true, ...permissions }
}

/**
 * Installed and running apps, for the Settings app picker and for showing names
 * next to stored bundle ids. Empty when Computer Use is off or the daemon is
 * unavailable: the picker is a convenience, the rules work without it.
 */
export async function listComputerUseApps(): Promise<Array<{ bundleId: string; name: string; running: boolean }>> {
  const socketPath = await ensureComputerUseService()
  if (!socketPath || !cuaDriverService) return []
  return await cuaDriverService.listApps().catch((e) => {
    logger.warn(`failed to list apps for computer use settings: ${e}`)
    return []
  })
}

/** The host grant state the daemon was last restarted for; see above. */
let restartedForHostGrants: string | undefined

/**
 * Ask macOS for a grant.
 *
 * This has to come from the app, not the daemon: embedded cua-driver inherits
 * the app's grants but never raises a consent dialog itself. Electron registers
 * the bridge; a headless server has no app to ask on behalf of.
 */
export async function openComputerUsePermissionSettings(
  permission: ComputerUsePermissionKind,
): Promise<void> {
  const host = getComputerUseHostPermissions()
  if (!host) throw new Error('Granting macOS permissions requires the Operon desktop app')
  await host.request(permission)
}

/** Stop the daemon. Called by the toggle route and by the host on quit. */
export async function stopComputerUseService(): Promise<void> {
  const driver = cuaDriverService
  cuaDriverService = null
  await driver?.stop().catch(() => {})
}

setComputerUseServiceStopHandler(stopComputerUseService)

function sweepIdle() {
  const now = Date.now()
  for (const [id, e] of bySession) {
    if (now - e.lastUsed < IDLE_MS) continue
    bySession.delete(id)
    void e.dispose().catch(() => {})
    logger.info(`disposed idle node_repl session ${id}`)
  }
  // With every conversation gone the kernel is ~63 MB serving nothing. Let it go;
  // the next session pays one fork to bring it back, which is the same cost it
  // would have paid anyway.
  if (bySession.size === 0 && sharedKernel) {
    const kernel = sharedKernel
    sharedKernel = null
    void kernel.dispose().catch(() => {})
    logger.info('disposed idle shared node_repl kernel')
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

function enabledSurfaces(): NodeReplSurface[] {
  return [
    ...(getComputerUseConfig().enabled ? (['computer'] as const) : []),
    ...(getBrowserUseConfig().enabled ? (['browser'] as const) : []),
    ...(getChromeUseConfig().enabled ? (['chrome'] as const) : []),
  ]
}

/**
 * One endpoint for every conversation of a client that cannot hold a URL per
 * conversation — OpenCode, which shares one MCP client per server name across a
 * directory. Each tools/call names its conversation instead (see mcp-caller.ts)
 * and runs in that conversation's own session, the same Entry a URL-scoped
 * client would reach.
 *
 * Stateless is enough here. The stateful transport exists for the MCP
 * elicitation back-channel, but a session with a chat id asks the user through
 * the host (`requestOperonElicitation`), never through the client.
 *
 * tools/list carries no conversation, so it describes the current toggles; a
 * session built before a toggle flipped keeps the surfaces it was built with.
 */
function buildCallerRoutedServer(sessionKey: string | null): Server {
  const server = new Server({ name: 'node_repl', version: '0.1.0' }, { capabilities: { tools: {}, logging: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => listNodeReplTools(enabledSurfaces()))
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    if (sessionKey == null) {
      return { content: [{ type: 'text', text: UNKNOWN_CALLER_MESSAGE }], isError: true }
    }
    const entry = await entryFor(sessionKey)
    return entry.callTool(req, extra)
  })
  return server
}

async function buildEntry(sessionId: string): Promise<Entry> {
  // Only start the daemon when Computer Use is on. With it off, a model calling
  // `computer.*` fails to reach the socket and gets an error, while Browser Use,
  // which does not need it, keeps working.
  const socketPath = await ensureComputerUseService()
  // The surfaces this session gets, from the same three toggles mcp-config gates
  // the mount on. They decide two things the model sees directly: which globals
  // the banner installs, and what the `js` description claims exists.
  //
  // Baked in at creation, like the URL and the kernel itself. A toggle flipped
  // later cannot reach a live session; the route's own check catches the case
  // where all three went off.
  const surfaces = enabledSurfaces()
  const chatId = Number(sessionId)
  // Who answers this context's permission prompts: the chat's own approval card, or — for a
  // personal-assistant worker — the assistant's. Without either the kernel would allow everything.
  const assistantWorker = sessionId.startsWith(ASSISTANT_NODE_REPL_PREFIX) ? sessionId.slice(ASSISTANT_NODE_REPL_PREFIX.length) : undefined
  const hostElicitation = assistantWorker
    ? (request: { message: string; meta?: unknown }) => requestAssistantElicitation(assistantWorker, request)
    : Number.isSafeInteger(chatId) && chatId > 0
      ? (request: { message: string; meta?: unknown }) => requestOperonElicitation(chatId, request)
      : undefined
  const built = await buildNodeReplMcpServer({
    surfaces,
    // Always `autoStart: false`, even when Computer Use is on. This code path is
    // per-session, and `createComputerUse` would otherwise start a daemon of its
    // own. The socket path is derived from the pid — one value for the whole
    // process — so a daemon per session would fight over a single socket, and
    // whichever session disposed first would `service.stop()` everyone else's
    // engine with it. This module owns one shared daemon instead; all we pass
    // down here is its socketPath so the kernel can connect. (With autoStart
    // false, `stop()` sees `this.proc == null` and returns without side effects.)
    driver: {
      autoStart: false,
      ...(CUA_DRIVER_BINARY ? { binaryPath: CUA_DRIVER_BINARY } : {}),
      ...(socketPath ? { socketPath } : {}),
    },
    // One shared kernel process, a vm context per conversation. The fork-time
    // configuration that used to be repeated here — nodeRepl.env, the import
    // allowlist, the config store, the CU socket and its token — is identical
    // for every session and now lives on the shared kernel; see
    // sharedNodeReplKernel above.
    host: sharedNodeReplKernel,
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
    // With `host` set this is the fallback for a session that forks its own kernel;
    // the shared kernel carries its own store. Both are createTomlConfigStore().
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
      // No conversation in the URL: a shared registration whose calls each name
      // their own. A call that names none fails rather than picking a kernel.
      const caller = await resolveMcpCallerChat(c, 'sessionId')
      if (!caller.ok) return caller.response
      await ensureComputerUseService()
      const sessionKey = caller.assistantWorker
        ? `${ASSISTANT_NODE_REPL_PREFIX}${caller.assistantWorker}`
        : caller.chatId != null ? String(caller.chatId) : null
      return serveMcpOverHono(c, buildCallerRoutedServer(sessionKey), caller.body)
    }
    // Existing sessions used to bypass ensureComputerUseService entirely. Check
    // on every MCP request so a daemon crash heals before the next computer.* call.
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
 * The shared cua-driver daemon goes with them: it is a long-lived child process
 * we spawned too, and clearing only the kernels would leave it running.
 */
export async function disposeAllNodeReplSessions(): Promise<void> {
  const all = [...bySession.values()]
  bySession.clear()
  await Promise.allSettled(all.map((e) => e.dispose()))
  // The kernel is shared, so no session's dispose kills it. It is a long-lived
  // child process we forked, and clearing only the contexts would leave it running.
  const kernel = sharedKernel
  sharedKernel = null
  await kernel?.dispose().catch(() => {})
  await stopComputerUseService()
}
