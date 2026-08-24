import type * as acp from '@zed-industries/agent-client-protocol'
import { getRuntimeHost } from '../../host.js'
import { buildRuntimeEnv } from '../../runtime-env.js'
import { createRuntimeLogger } from '../../logger.js'
import type { ProviderDescriptor } from '../../types.js'
import { toSlashCommands } from './commands.js'
import { ACP_PROTOCOL_VERSION, AcpConnection } from './connection.js'
import type { AcpDiscoveryContext, AcpProviderConfig } from './types.js'

const logger = createRuntimeLogger('acp-discovery')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
// cursor-agent currently publishes available_commands_update about 2.2s after
// session/new on a cold start. Keep enough headroom for startup variance; this
// runs only in the background discovery process and never blocks the app window.
const COMMAND_PROBE_TIMEOUT_MS = 5000

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
export async function probeAcpModels(config: AcpProviderConfig): Promise<AcpDiscoveryContext> {
  const empty: AcpDiscoveryContext = { initialize: null, session: null, commands: null }
  // Commands only exist inside a session, so wanting them forces the deeper probe.
  const needsSession = config.modelProbe === 'session' || config.probeCommands === true
  if (config.modelProbe === 'none' && !config.probeCommands) return empty

  const cliPath = getRuntimeHost().resolveCliPath(config.cliId) ?? config.fallbackCommand
  if (!cliPath) return empty

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
      env: buildRuntimeEnv(),
      callbacks: {
        onSessionUpdate: (params) => {
          if (params.update.sessionUpdate !== 'available_commands_update') return
          commands = params.update.availableCommands
          onCommands?.()
        },
        onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        onExit: () => {},
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
    let session = null
    if (needsSession) {
      session = await withTimeout(
        connection.agent.newSession({ cwd: process.cwd(), mcpServers: [] }),
        12000,
        `${config.providerId} newSession`,
      )
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
    logger.warn(`Failed to probe ${config.providerId} models: ${error instanceof Error ? error.message : String(error)}`)
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
  return {
    id: config.providerId,
    label: config.label,
    logo: config.logo,
    models: resolved.models,
    modes: config.modes,
    commands: [],
    slashCommands: discovered.length > 0 ? discovered : FALLBACK_SLASH_COMMANDS,
    currentModelId: resolved.currentModelId,
    currentModeId: resolved.currentModeId,
    features: config.features,
  }
}
