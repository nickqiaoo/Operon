import { execFileSync } from 'node:child_process'
import type { Model } from '../../types.js'
import type { AcpDiscoveryContext, AcpModelDiscovery, AcpProviderConfig } from '../acp/index.js'

/**
 * Google Antigravity over ACP.
 *
 * The agent is `agy_acp_server`, a separate ~765MB binary distributed through
 * the ACP registry — NOT the `agy` CLI, which has no ACP mode at all. Despite
 * the `.par` extension it is a native Mach-O/ELF executable and runs directly.
 * Users install it themselves (proprietary licence, 886MB unpacked), so there
 * is no `fallbackCommand`: without a configured path the provider stays
 * unavailable rather than shelling out to something that isn't there.
 */
/**
 * The agent's own default, as advertised by `session/new`.
 *
 * Take these ids from the ACP handshake, never from `agy models`: the CLI and
 * the ACP server use different id spaces for the same model. "Gemini 3.1 Pro
 * (High)" is `gemini-3.1-pro-high` to the CLI but `gemini-pro-agent` over ACP,
 * and a CLI id sent to `setSessionModel` names nothing.
 *
 * Matching the agent's default also keeps the label honest: the shared session
 * only calls `setSessionModel` when the selection differs from this constant,
 * so a default that the agent does not actually start on would leave operon
 * displaying one model while the agent ran another.
 */
export const ANTIGRAVITY_DEFAULT_MODEL_ID = 'gemini-3.7-flash-high'

const ANTIGRAVITY_FALLBACK_MODELS: Model[] = [
  {
    id: ANTIGRAVITY_DEFAULT_MODEL_ID,
    name: 'Gemini 3.7 Flash (High)',
    description: "Google's Antigravity coding agent",
    providerId: 'antigravity',
    providerLabel: 'Antigravity',
    providerLogo: 'antigravity',
  },
]

/**
 * Antigravity advertises its models on the `session/new` response, not on
 * `initialize` — hence `modelProbe: 'session'`. Ids are flat strings that
 * already encode the reasoning effort (`gemini-3.8-flash-high`), so they
 * round-trip through `setSessionModel` as-is.
 */
function extractAntigravityModels(
  ctx: AcpDiscoveryContext,
  preferredModelId?: string,
): AcpModelDiscovery {
  const available = ctx.session?.models?.availableModels ?? []
  const models: Model[] = available.map((entry) => ({
    id: entry.modelId,
    name: entry.name || entry.modelId,
    providerId: 'antigravity',
    providerLabel: 'Antigravity',
    providerLogo: 'antigravity',
  }))

  const resolved = models.length > 0 ? models : ANTIGRAVITY_FALLBACK_MODELS
  const availableIds = new Set(resolved.map((m) => m.id))
  const advertisedCurrent = ctx.session?.models?.currentModelId

  const currentModelId =
    preferredModelId && availableIds.has(preferredModelId)
      ? preferredModelId
      : advertisedCurrent && availableIds.has(advertisedCurrent)
        ? advertisedCurrent
        : resolved.find((m) => m.id === ANTIGRAVITY_DEFAULT_MODEL_ID)?.id ?? resolved[0].id
  // A stale preference (a model id that no longer exists, or a CLI-shaped one)
  // must not survive as the label: it would name a model the agent cannot select.

  return { models: resolved, currentModelId }
}

/** macOS system proxy, read once per process. `null` once we know there is none. */
let cachedSystemHttpProxy: string | null | undefined

/**
 * The macOS system HTTP proxy, as a URL — or null when there isn't one.
 *
 * Only consulted to work around the SOCKS problem below, so a failure to read
 * it is not worth reporting: the caller just leaves the environment alone.
 */
function readMacSystemHttpProxy(): string | null {
  if (cachedSystemHttpProxy !== undefined) return cachedSystemHttpProxy
  cachedSystemHttpProxy = null
  try {
    const out = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 2000 })
    const enabled = /HTTPEnable\s*:\s*1/.test(out)
    const host = out.match(/HTTPProxy\s*:\s*(\S+)/)?.[1]
    const port = out.match(/HTTPPort\s*:\s*(\d+)/)?.[1]
    const socksOn = /SOCKSEnable\s*:\s*1/.test(out)
    // Only bother when SOCKS is actually the thing that would break us.
    if (socksOn && enabled && host && port) cachedSystemHttpProxy = `http://${host}:${port}`
  } catch {
    // scutil missing or slow — nothing to do.
  }
  return cachedSystemHttpProxy
}

/**
 * Keep the agent away from a macOS system-wide SOCKS proxy.
 *
 * `agy_acp_server` is a packaged Python app, and Python resolves proxies by
 * falling back to the OS settings when no proxy env var is set. It does not
 * bundle `python-socks`, so a machine with system SOCKS enabled — the default
 * shape of every Clash/Surge setup, i.e. most users behind the GFW — fails
 * every request with:
 *
 *     Internal error: "python-socks is required to use a SOCKS proxy"
 *
 * Setting an explicit HTTP proxy stops Python consulting the OS at all. We only
 * do it when the user has no proxy env of their own (theirs wins), SOCKS is on,
 * and the same machine also exposes an HTTP proxy to switch to — which is the
 * usual mixed-port setup. Anything else is left untouched.
 */
function patchAntigravityEnv(env: Record<string, string>): Record<string, string> {
  if (process.platform !== 'darwin') return env
  const alreadySet = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
  if (alreadySet.some((key) => env[key]?.trim())) return env

  const proxy = readMacSystemHttpProxy()
  if (!proxy) return env
  return { ...env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy }
}

export const ANTIGRAVITY_CONFIG: AcpProviderConfig = {
  providerId: 'antigravity',
  cliId: 'antigravity',
  label: 'Antigravity',
  logo: 'antigravity',
  // The server takes no subcommand — the binary itself is the ACP agent.
  agentArgs: [],
  patchEnv: patchAntigravityEnv,
  // Straight off the `session/new` response's `availableModes`.
  modes: [
    { id: 'default', name: 'Default', description: 'Ask before edits and commands' },
    { id: 'auto_edit', name: 'Auto Edit', description: 'Auto-approve file edits' },
    { id: 'yolo', name: 'YOLO', description: 'Auto-approve everything' },
  ],
  defaultModeId: 'default',
  defaultModelId: ANTIGRAVITY_DEFAULT_MODEL_ID,
  features: {
    permissions: true,
    // `promptCapabilities` advertises image + audio + embeddedContext.
    attachments: true,
    injection: false,
    sessionResume: true,
  },
  modelProbe: 'session',
  extractModels: extractAntigravityModels,
  // No `parseUsage` / `parseContextTokens`: the agent reports none over ACP.
  //
  // Measured across a full turn with every client capability declared — the
  // `session/prompt` response is `{stopReason}` with no `_meta`, no
  // `session/update` carries one, and `session/new`'s `configOptions` offers
  // only model and mode. ACP's `_meta` is the standard place for this (Grok
  // fills it); Antigravity simply does not.
  //
  // The numbers do exist, but only in the server's debug log: it prints its
  // raw WebSocket traffic with Google's backend, and a `usageUpdate` frame
  // there carries promptTokenCount / candidatesTokenCount / thoughtsTokenCount
  // keyed by `trajectoryId` (which equals the ACP session id). Scraping stderr
  // for them was considered and deliberately declined — it would bind us to a
  // debug log format rather than an API. If a future release fills `_meta`,
  // implement these hooks and the badge lights up on its own.
}
