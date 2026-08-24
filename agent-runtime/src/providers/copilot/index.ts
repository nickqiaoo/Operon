import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk'
import type {
  EffortLevel,
  Model,
  ProviderDescriptor,
  ProviderInfo,
  RuntimeProviderFactory,
  RuntimeSession,
  RuntimeSessionParams,
  SlashCommandItem,
} from '../../types.js'
import { createRuntimeLogger } from '../../logger.js'
import {
  COPILOT_DEFAULT_MODE,
  COPILOT_DEFAULT_MODEL,
  COPILOT_MODES,
  COPILOT_THINKING_LEVELS,
  copilotRuntimeEnv,
  resolveCopilotCliPath,
} from './config.js'
import { CopilotRuntimeSession } from './session.js'
import {
  createCopilotSlashCommandState,
  getCopilotSlashCommands,
} from './slash-commands.js'

const logger = createRuntimeLogger('copilot')

// Live model list, fetched once per process via listModels() and cached. The
// available models are plan-specific, so we never rely on a hardcoded set.
let sharedModels: Model[] | null = null
let sharedSlashCommands: SlashCommandItem[] | null = null
let sharedFetchPromise: Promise<void> | null = null

const EFFORT_LEVELS = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max'])

// Always returns an array (never undefined): models that don't support effort
// must report `[]`, not absence, so the frontend's per-model gate fires. With
// `undefined` the picker falls back to a heuristic and wrongly shows effort
// options (e.g. for `auto`); with `[]` it filters to nothing and hides them.
function toEffortLevels(efforts: readonly string[] | undefined): EffortLevel[] {
  if (!efforts?.length) return []
  return efforts.filter((e): e is EffortLevel => EFFORT_LEVELS.has(e as EffortLevel))
}

/**
 * Reasoning-effort levels the given model accepts, from the cached live list.
 * Passed into the session at creation so it only sends `reasoningEffort` for
 * models that support it (the SDK throws otherwise — e.g. on `auto`). Empty when
 * the model is unknown or the list hasn't loaded yet, which safely disables it.
 */
function effortLevelsForModel(modelId: string | undefined): string[] {
  if (!modelId) return []
  return sharedModels?.find((m) => m.id === modelId)?.supportedEffortLevels ?? []
}

// Safety cap on the live model probe. The copilot runtime needs ~10s+ to become
// ready (update check + GitHub MCP connect) before listModels() resolves, so
// this has to be generous. It's fine that it's long because the probe runs in
// the BACKGROUND (see fetchInitInfo) and never blocks the picker — the cap only
// guards against a genuinely stuck runtime leaking its spawned process.
const MODEL_PROBE_TIMEOUT_MS = 20000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

async function discoverSlashCommands(client: CopilotClient): Promise<SlashCommandItem[]> {
  const state = createCopilotSlashCommandState()
  const [commandsResult, skillsResult] = await Promise.allSettled([
    withTimeout(
      client.rpc.commands.list(),
      MODEL_PROBE_TIMEOUT_MS,
      'copilot commands.list()',
    ),
    withTimeout(
      client.rpc.skills.discover({ projectPaths: [process.cwd()] }),
      MODEL_PROBE_TIMEOUT_MS,
      'copilot skills.discover()',
    ),
  ])

  if (commandsResult.status === 'fulfilled') {
    state.commands = commandsResult.value.commands.map((command) => ({
      name: command.name,
      description: command.description ?? '',
      type: command.kind === 'skill' ? 'skill' : 'command',
    }))
    state.receivedCommands = true
  } else {
    logger.warn(
      `commands.list failed: ${
        commandsResult.reason instanceof Error
          ? commandsResult.reason.message
          : String(commandsResult.reason)
      }`,
    )
  }

  if (skillsResult.status === 'fulfilled') {
    state.skills = skillsResult.value.skills
      .filter((skill) => skill.userInvocable && skill.enabled)
      .map((skill) => ({
        name: skill.name,
        description: skill.description ?? '',
        type: 'skill',
      }))
    state.receivedSkills = true
  } else {
    logger.warn(
      `skills.discover failed: ${
        skillsResult.reason instanceof Error
          ? skillsResult.reason.message
          : String(skillsResult.reason)
      }`,
    )
  }

  if (!state.receivedCommands && !state.receivedSkills) {
    throw new Error('copilot command and skill discovery both failed')
  }
  return getCopilotSlashCommands(state)
}

async function doFetchModels(): Promise<void> {
  // copilotRuntimeEnv() sets ELECTRON_RUN_AS_NODE so a `.js` runtime runs as
  // plain Node instead of a full Electron app (see config.ts) — without it,
  // start()/listModels stall inside the Electron main process.
  const client = new CopilotClient({
    workingDirectory: process.cwd(),
    env: copilotRuntimeEnv(),
    // Unconditional — see resolveCopilotCliPath(); an omitted `connection` would
    // send the SDK looking for a bundled runtime this build does not ship.
    connection: RuntimeConnection.forStdio({ path: resolveCopilotCliPath() }),
  })
  try {
    await withTimeout(client.start(), MODEL_PROBE_TIMEOUT_MS, 'copilot start()')
    const models = await withTimeout(client.listModels(), MODEL_PROBE_TIMEOUT_MS, 'copilot listModels()')
    const discoveredModels = models.map((m) => ({
      id: m.id,
      name: m.name,
      supportedEffortLevels: toEffortLevels(m.supportedReasoningEfforts),
    }))
    const discoveredSlashCommands = await discoverSlashCommands(client)

    // Publish one coherent descriptor snapshot only after both probes finish.
    sharedModels = discoveredModels
    sharedSlashCommands = discoveredSlashCommands
    logger.info(`fetched ${sharedModels.length} models: ${sharedModels.map((m) => m.id).join(', ')}`)
    logger.info(`fetched ${sharedSlashCommands.length} slash commands`)
  } finally {
    // forceStop, not stop: graceful stop() can hang, and this probe client has
    // no session state worth flushing.
    await client.forceStop().catch(() => {})
  }
}

export class CopilotRuntimeProvider implements RuntimeProviderFactory {
  static readonly providerInfo: ProviderInfo = {
    id: 'copilot',
    label: 'GitHub Copilot',
    logo: 'copilot',
  }

  readonly providerInfo = CopilotRuntimeProvider.providerInfo
  private currentModelId = COPILOT_DEFAULT_MODEL
  private currentModeId = COPILOT_DEFAULT_MODE
  // Undefined = use the model's own default reasoning effort (and omit it for
  // models that don't support effort at all).
  private currentThinkingLevel: string | undefined

  /**
   * Kick off the live model fetch in the BACKGROUND — intentionally not awaited.
   * The copilot runtime takes ~10s+ to warm up (update check + GitHub MCP
   * connect) before listModels() resolves, and blocking the descriptor that long
   * would leave the model picker spinning every time it's opened. getDescriptor()
   * returns whatever is cached (empty until the probe finishes); once this
   * resolves, the live list is used on the next descriptor fetch.
   * Result is cached per process, so this runs at most once.
   */
  async fetchInitInfo(): Promise<void> {
    if (sharedModels || sharedFetchPromise) return
    sharedFetchPromise = doFetchModels()
      .catch((err) => {
        logger.warn(`listModels failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        sharedFetchPromise = null
      })
    // Not awaited — see doc comment above.
  }

  async getDescriptor(): Promise<ProviderDescriptor> {
    const models: Model[] = sharedModels ?? []
    return {
      id: 'copilot',
      label: 'GitHub Copilot',
      logo: 'copilot',
      models,
      modelsPending: sharedModels === null,
      modes: COPILOT_MODES,
      thinkingLevels: COPILOT_THINKING_LEVELS,
      commands: [],
      slashCommands: sharedSlashCommands ?? [],
      currentModelId: this.currentModelId,
      currentModeId: this.currentModeId,
      currentThinkingLevel: this.currentThinkingLevel,
      features: {
        // Normal mode surfaces a per-action approval card via onPermissionRequest
        // (Autopilot/Plan auto-approve). Attachments/mid-turn injection aren't
        // wired yet; the SDK persists session state so resume-based continuity works.
        permissions: true,
        attachments: false,
        injection: false,
        sessionResume: true,
      },
    }
  }

  async createSession(params: RuntimeSessionParams): Promise<RuntimeSession> {
    if (params.modelId) this.currentModelId = params.modelId
    if (params.modeId) this.currentModeId = params.modeId
    if (params.thinkingLevel) this.currentThinkingLevel = params.thinkingLevel
    // Resolve the model's accepted effort levels now (cache is loaded by the time
    // the picker has been shown) so the session can gate `reasoningEffort`.
    const supportedEffortLevels = effortLevelsForModel(params.modelId ?? this.currentModelId)
    return new CopilotRuntimeSession(params, supportedEffortLevels)
  }
}
