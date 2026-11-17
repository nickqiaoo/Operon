import type * as acp from '@agentclientprotocol/sdk'
import type { RuntimeContext } from '../../context.js'
import { createRuntimeLogger } from '../../logger.js'
import type { ProviderDescriptor } from '../../types.js'
import { toSlashCommands } from './commands.js'
import { configValues, findConfigOption, thinkingConfig } from './config-options.js'
import { ACP_PROTOCOL_VERSION, AcpConnection } from './connection.js'
import type { AcpDiscoveryContext, AcpProviderConfig } from './types.js'

const logger = createRuntimeLogger('acp-discovery')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
// cursor-agent currently publishes available_commands_update about 2.2s after
// session/new on a cold start. Keep enough headroom for startup variance; this
// runs only in the background discovery process and never blocks the app window.
const COMMAND_PROBE_TIMEOUT_MS = 5000
/** How long the descriptor waits on `session/new` before falling back to static models. */
const NEW_SESSION_TIMEOUT_MS = 12000
/**
 * How long a probe whose `session/new` outlived the descriptor wait is kept alive.
 *
 * A slow `session/new` is usually the agent waiting on an interactive sign-in:
 * Antigravity opens a browser login page when its stored credentials are
 * rejected, and the OAuth callback lands on a local listener inside that very
 * process. Killing it at the descriptor timeout made the login impossible to
 * finish — and the next probe opened yet another page.
 */
const LOGIN_GRACE_MS = 10 * 60_000
/** Stderr lines kept per probe, replayed in the log when the probe fails. */
const STDERR_TAIL_LINES = 20

/** Probes parked while their agent waits on a sign-in, by provider id. */
const pendingLogins = new Map<string, AcpConnection>()

function disposePendingLogins(): void {
  for (const [providerId, connection] of pendingLogins) {
    pendingLogins.delete(providerId)
    void connection.dispose()
  }
}

/**
 * Keep a probe whose `session/new` is still pending alive until it settles, so
 * a sign-in it started can complete. Once it does, the credentials are on disk
 * and the next descriptor refresh probes cleanly.
 */
function parkForLogin(
  providerId: string,
  connection: AcpConnection,
  pendingSession: Promise<unknown>,
  stderrTail: string[],
): void {
  pendingLogins.set(providerId, connection)
  const tail = stderrTail.length > 0 ? `\n${stderrTail.join('\n')}` : ''
  logger.warn(
    `${providerId} newSession still pending after ${NEW_SESSION_TIMEOUT_MS}ms — likely waiting for sign-in; ` +
      `keeping the probe alive for up to ${LOGIN_GRACE_MS / 60_000} min${tail}`,
  )

  let settled = false
  const finish = (outcome: string): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (pendingLogins.get(providerId) === connection) pendingLogins.delete(providerId)
    void connection.dispose()
    logger.info(`${providerId} parked probe ${outcome}`)
  }
  const timer = setTimeout(() => finish(`gave up after ${LOGIN_GRACE_MS / 60_000} min`), LOGIN_GRACE_MS)
  timer.unref?.()
  pendingSession.then(
    () => finish('completed newSession (sign-in done)'),
    (error: unknown) => finish(`failed: ${error instanceof Error ? error.message : String(error)}`),
  )
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Run a one-shot handshake to discover a provider's model list, going only as
 * deep as `config.modelProbe` requires, then tear the process down. Returns an
 * empty context on failure so callers fall back to static defaults.
 */
export async function probeAcpModels(ctx: RuntimeContext, config: AcpProviderConfig): Promise<AcpDiscoveryContext> {
  const empty: AcpDiscoveryContext = { initialize: null, session: null, commands: null }
  // Commands only exist inside a session, so wanting them forces the deeper probe.
  const needsSession = config.modelProbe === 'session' || config.probeCommands === true
  if (config.modelProbe === 'none' && !config.probeCommands) return empty

  const cliPath = ctx.resolveBinary(config.cliId) ?? config.fallbackCommand
  if (!cliPath) return empty

  // An earlier probe is still waiting on a sign-in: spawning another would only
  // open a second login page. Fall back to static models until it settles.
  if (pendingLogins.has(config.providerId)) {
    logger.debug(`${config.providerId} probe skipped: an earlier probe is waiting for sign-in`)
    return empty
  }
  ctx.shared('acp:pending-login-probes', () => ({ dispose: disposePendingLogins }))

  const stderrTail: string[] = []

  // The push can in principle beat the newSession response, so capture it from
  // the first notification rather than starting to listen once newSession returns.
  let commands: acp.AvailableCommand[] | null = null
  let onCommands: (() => void) | null = null
  const commandsPushed = new Promise<void>((resolve) => {
    onCommands = resolve
  })

  let connection: AcpConnection | null = null
  try {
    connection = new AcpConnection({
      providerId: config.providerId,
      command: cliPath,
      args: config.agentArgs,
      cwd: process.cwd(),
      env: config.patchEnv ? config.patchEnv(ctx.env()) : ctx.env(),
      // A throwaway probe keeps its own process rather than borrowing a shared
      // one: it runs before any conversation exists and is disposed immediately.
      callbacks: {
        onStderr: (line) => {
          stderrTail.push(line)
          if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift()
        },
      },
      onProcessExit: () => {
        if (connection && pendingLogins.get(config.providerId) === connection) {
          pendingLogins.delete(config.providerId)
        }
      },
    })
    const initialize = await withTimeout(
      connection.agent.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      8000,
      `${config.providerId} initialize`,
    )
    let session: AcpDiscoveryContext['session'] = null
    if (needsSession) {
      const pendingSession = connection.agent.newSession({ cwd: process.cwd(), mcpServers: [] })
      const settled = await Promise.race([
        pendingSession.then((value) => ({ value })),
        delay(NEW_SESSION_TIMEOUT_MS).then(() => null),
      ])
      if (!settled) {
        // Hand the process over instead of killing it in `finally`.
        parkForLogin(config.providerId, connection, pendingSession, stderrTail)
        connection = null
        return empty
      }
      session = settled.value
      // Commands can be pushed in the same tick `session/new` is answered; the
      // connection buffers those and replays them on registration.
      connection.registerSession(session.sessionId, {
        onSessionUpdate: (params) => {
          if (params.update.sessionUpdate === 'config_option_update') {
            if (session) session.configOptions = params.update.configOptions
            return
          }
          if (params.update.sessionUpdate !== 'available_commands_update') return
          commands = params.update.availableCommands
          onCommands?.()
        },
        onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        onExit: () => {},
      })
    }
    if (config.probeCommands && commands === null) {
      // The ceiling is only there so an agent that never pushes cannot keep the
      // descriptor probe alive forever. Missing commands degrade to the static
      // list — never fail the probe over them.
      await Promise.race([commandsPushed, delay(COMMAND_PROBE_TIMEOUT_MS)])
      if (commands === null) {
        logger.warn(
          `${config.providerId} advertised no commands within ${COMMAND_PROBE_TIMEOUT_MS}ms`,
        )
      }
    }
    return { initialize, session, commands }
  } catch (error) {
    const tail = stderrTail.length > 0 ? `\n${stderrTail.join('\n')}` : ''
    logger.warn(
      `Failed to probe ${config.providerId} models: ${error instanceof Error ? error.message : String(error)}${tail}`,
    )
    return empty
  } finally {
    await connection?.dispose()
  }
}

/**
 * Every ACP agent supports `/compact`; it is the floor used when an agent was
 * not probed for commands, or the probe came back empty.
 */
const FALLBACK_SLASH_COMMANDS: ProviderDescriptor['slashCommands'] = [
  { name: 'compact', description: 'Compact conversation history', type: 'command' },
]

/** Assemble a `ProviderDescriptor` from a provider config and resolved models. */
export function buildAcpDescriptor(
  config: AcpProviderConfig,
  resolved: { models: ProviderDescriptor['models']; currentModelId: string; currentModeId: string },
  ctx?: AcpDiscoveryContext,
): ProviderDescriptor {
  const discovered = toSlashCommands(config, ctx?.commands)
  const options = ctx?.session?.configOptions ?? []
  const model = findConfigOption(options, 'model')
  const mode = findConfigOption(options, 'mode')
  return {
    id: config.providerId,
    label: config.label,
    logo: config.logo,
    models: model ? configValues(model).map((entry) => ({
      ...resolved.models.find((candidate) => candidate.id === entry.value),
      id: entry.value,
      name: entry.name,
      description: entry.description ?? undefined,
      providerId: config.providerId,
      providerLabel: config.label,
      providerLogo: config.logo,
    })) : resolved.models,
    modes: mode ? configValues(mode).map((entry) => ({ id: entry.value, name: entry.name, description: entry.description ?? undefined })) : config.modes,
    commands: [],
    slashCommands: discovered.length > 0 ? discovered : FALLBACK_SLASH_COMMANDS,
    currentModelId: model?.currentValue ?? resolved.currentModelId,
    currentModeId: mode?.currentValue ?? resolved.currentModeId,
    ...thinkingConfig(ctx?.session?.configOptions ?? []),
    features: { ...config.features, steer: false, followup: true, ...(options.length > 0 ? { dynamicSwitch: true } : {}) },
  }
}
