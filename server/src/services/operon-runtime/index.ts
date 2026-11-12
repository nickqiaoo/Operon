import path from 'path'
import { getOperonHome } from '../../../../shared/operon-home.js'
import { mkdir, stat } from 'fs/promises'
import { codeMode } from 'operon-code-mode'
import { createLocalHarness, LocalEnvironment, resolveSessionConfig, type AutoApprover, type Harness, type HarnessSession, type McpServerConfig, type PermissionMode, type PermissionRule, type ThinkingLevel as EngineThinkingLevel, type Tool } from 'operon-agents'
import { createAutoApprover, defaultCapabilities, filesystemTools, resolveFromFiles, toCoreOptions, WorkspaceMcpPool, type AutoApprovalOptions } from 'operon-agents/advanced'
import { loadMcpServers } from 'operon-agents/mcp'
import { getTelemetry } from '../analytics/telemetry.js'
import { getProviderConfigs, isProviderUsable, onProviderConfigChange } from '../provider-config.js'
import { defineProvider } from '@operon/agent-runtime'
import type {
  Model,
  ProviderDescriptor,
  ProviderInfo,
  RuntimeProviderFactory,
  RuntimeMcpServers,
  SessionOptions,
  ThinkingLevel,
} from '@operon/agent-runtime'
import { createOperonTracing } from './tracing.js'
import { modelManager, modelRef, resolveReviewModel, syncModelProvider, syncModelProviders } from './resolve-model.js'
import { withAutoReviewModel } from './auto-review.js'
import { getAutoReviewConfig } from '../auto-review-config.js'
import { MODE_TO_PERMISSION, OperonRuntimeSession, type OperonSessionNative } from './session.js'
import { EXTENSIONS_DIR, HARNESS_HOME_DIR } from './paths.js'
import { configurePeersHost, createTeamsHostService, restoredSessionConfig } from './peers.js'
import { TEAMS_SERVICE } from '../../extensions/peers/contract.js'
import { loadApprovedExtensions, syncApprovedExtensions } from './approved-extensions.js'
import { resumeRuntimeSession, workspaceSessionConfig, type SessionLimitsConfig, type SessionPermissionConfig, type WorkspaceSessionSetup } from './session-lifecycle.js'
import { observeSession, startSessionWatch } from './passive-observer.js'
import { getChatStorage } from '../ai/state.js'
import { ensurePluginsLoaded, pluginManager } from './plugins.js'
import { mcpOAuthService } from './mcp-oauth.js'
import { availableModels } from './models.js'
import { DEFAULT_PERMISSION_RULES, withDefaultPermissionRules } from './default-permission-rules.js'

const DEFAULT_MODEL_ID = 'anthropic/claude-sonnet-4-6'

// Extra tools to merge into the default agent's toolset, on top of the builtin
// coding tools. Empty by default, so normal chat behaviour is unchanged. The
// memory benchmark adapter registers `memory_search`/`memory_upsert` here so the
// in-process `custom` extraction agent gets the same memory tools the CLI
// providers receive via MCP injection. Must be set before the first session.
let registeredExtraTools: readonly Tool[] = []

/** Register tools to add to every operon session's default agent. Idempotent
 *  replace (last-wins). Pass an empty array to clear. */
export function registerOperonRuntimeTools(tools: readonly Tool[]): void {
  registeredExtraTools = tools
}

// Persist the framework session tree on disk so chats survive reopen / restart.
// The harness writes under `<homeDir>/sessions`; the route layer maps each chat's
// session `id` ↔ DB record and feeds it back as `resume`.
// Data dirs are shared with the plugin manager via ./paths.

// App namespace for config / MCP discovery. Drives the file layout the framework
// reads: `~/.operon/{config.toml,mcp.json}` (user tier), `<root>/.operon/…` +
// cross-tool `<root>/.mcp.json` (project tier), `<root>/.operon/config.local.toml`
// (local tier). MCP servers come ONLY from the mcp.json family — config.toml owns
// permission rules / loop control, never MCP (matches the Kimi-style split).
const APP_NAME = 'operon'

/** Per-workspace knobs read from `config.toml`, mapped to harness options. */
interface WorkspaceConfig {
  readonly permission: {
    readonly mode?: PermissionMode
    readonly rules: readonly PermissionRule[]
    readonly autoApproval?: AutoApprovalOptions
  }
  readonly maxTurns?: number
  readonly maxStepsPerTurn?: number
}

/**
 * Walk up from `cwd` to the nearest `.git` directory — the project root all three
 * config/MCP tiers resolve against. Falls back to `cwd` when none is found (mirrors
 * the framework's own `findProjectRoot`). One harness is built per root, so every
 * session in a repo shares its MCP servers, config, and subagent fleet.
 */
async function resolveProjectRoot(cwd: string): Promise<string> {
  let current = path.resolve(cwd)
  for (;;) {
    try {
      await stat(path.join(current, '.git'))
      return current
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(cwd)
    current = parent
  }
}

/**
 * Load the workspace's MCP servers across the user/project/local tiers. A malformed
 * `mcp.json` must not break the chat, so parse failures degrade to "no servers".
 */
async function loadWorkspaceMcpServers(root: string): Promise<Record<string, McpServerConfig>> {
  try {
    const { servers } = await loadMcpServers(new LocalEnvironment(root), { appName: APP_NAME, cwd: root, homeDir: getOperonHome() })
    return servers
  } catch (error) {
    console.warn(`[operon] failed to load MCP config under ${root}: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

/**
 * Load the workspace's `config.toml` (user/project/local tiers merged) and keep the
 * pieces that map onto harness options: permission rules + loop control. A malformed
 * config degrades to defaults rather than failing the chat.
 */
async function loadWorkspaceConfig(root: string): Promise<WorkspaceConfig> {
  try {
    const { config } = await resolveFromFiles({ appName: APP_NAME, cwd: root, homeDir: getOperonHome() })
    const core = toCoreOptions(config)
    return {
      permission: { ...core.permission, rules: withDefaultPermissionRules(core.permission.rules) },
      ...(core.loopControl.maxTurns !== undefined ? { maxTurns: core.loopControl.maxTurns } : {}),
      ...(core.loopControl.maxStepsPerTurn !== undefined ? { maxStepsPerTurn: core.loopControl.maxStepsPerTurn } : {}),
    }
  } catch (error) {
    console.warn(`[operon] failed to load config.toml under ${root}: ${error instanceof Error ? error.message : String(error)}`)
    return { permission: { rules: DEFAULT_PERMISSION_RULES } }
  }
}

// Thinking effort options offered in the picker. The UI filters these by each
// model's `supportedEffortLevels`, so unsupported levels are hidden per model. The
// id is sent back as `effort` and applied via `session.setThinking`.
const THINKING_LEVELS: ThinkingLevel[] = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'xhigh', name: 'Extra High' },
]

/**
 * Does this `provider/model` id belong to a provider the user has actually set up?
 *
 * `DEFAULT_MODEL_ID` names Anthropic, which most installs never configure. In the
 * chat UI that is harmless — the picker replaces it on the first descriptor fetch.
 * A headless caller (workflow sub-agent, commit message, memory maintenance) has no
 * picker, so an unconfigured default reaches the engine and yields an EMPTY turn
 * rather than an error, which reads as "the sub-agent returned nothing".
 */
function isProviderConfigured(modelId: string): boolean {
  const providerId = modelId.split('/')[0] ?? ''
  if (!providerId) return false
  const config = getProviderConfigs()[providerId]
  if (!config) return false
  // ollama and custom endpoints may need no key, just an address.
  return isProviderUsable(providerId, config)
}

/** Models the operon runtime can run right now (configured providers only), as `provider/model` ids. */
export function listOperonModels(): Promise<Model[]> {
  return availableModels()
}

interface WorkspaceSetup {
  permission: SessionPermissionConfig
  limits: SessionLimitsConfig
}

/**
 * One harness for the whole process. Nothing about it varies per workspace or per
 * conversation any more — workDir, MCP servers, permission policy, persona and the
 * Runner limits all ride the session — so there is nothing left to key a cache on.
 *
 * Module-level rather than per-provider-instance because `SessionManager.createProvider()`
 * builds a fresh provider for every session it creates; an instance-level cache would be
 * empty exactly when it matters, reconnecting every MCP server on each session rebuild.
 */
let HARNESS: Promise<Harness> | undefined
/** The built harness, once `buildHarness` resolved — for callers that must not trigger a build. */
let HARNESS_INSTANCE: Harness | undefined

/** `config.toml` per project root — read once, reused by every session there. */
const WORKSPACE_SETUPS = new Map<string, Promise<WorkspaceSetup>>()

/**
 * Resolve what a session is opened WITH from its workspace: the project root, the session's
 * own MCP servers (only the host-injected, conversation-scoped ones) and the permission policy
 * from `config.toml`. Cached by root so `config.toml` is one filesystem read per workspace.
 * Module-level so the peers extension can give a teammate the same policy its lead runs under.
 *
 * The workspace's `mcp.json` servers are deliberately NOT in `servers`: the `session` hook
 * borrows them from the directory's shared pool, so every chat in one project runs one set of
 * connections instead of spawning its own.
 */
export async function resolveWorkspaceSetup(
  cwd: string,
  injectedMcpServers?: RuntimeMcpServers,
): Promise<WorkspaceSessionSetup & { root: string }> {
  const root = await resolveProjectRoot(cwd)
  let pending = WORKSPACE_SETUPS.get(root)
  if (!pending) {
    pending = loadWorkspaceSetup(root).catch((error) => {
      WORKSPACE_SETUPS.delete(root)
      throw error
    })
    WORKSPACE_SETUPS.set(root, pending)
  }
  const setup = await pending
  return {
    root,
    // Private to the session, layered over the shared workspace servers: they carry the
    // conversation's own identity (operonrepl's kernel, the workflow/taskboard scope), so a
    // same-named workspace entry is shadowed for this session rather than masking them.
    servers: { ...(injectedMcpServers as Record<string, McpServerConfig> | undefined) },
    permission: setup.permission,
    limits: setup.limits,
  }
}

/** The process-wide harness (built on first use). Chat-less routes (extensions, teams) use this. */
export function getOperonHarness(): Promise<Harness> {
  if (!HARNESS) {
    HARNESS = buildHarness().catch((error) => {
      HARNESS = undefined
      throw error
    })
  }
  return HARNESS
}

async function loadWorkspaceSetup(root: string): Promise<WorkspaceSetup> {
  const config = await loadWorkspaceConfig(root)
  // The workspace's config.toml can extend the `auto`-tier judge's allow/deny/environment
  // sections. They ride the session's configuration; the one judge on the harness
  // (`buildAutoApprover`) is handed them on every call.
  const auto = config.permission.autoApproval
  return {
    // config.toml owns the permission rules; the UI mode picker sets the mode per-session via
    // `setPermissionMode`, so config.toml's `mode` is not carried (see workspaceSessionConfig).
    permission: {
      rules: [...config.permission.rules],
      ...(auto
        ? {
            autoApproval: {
              ...(auto.allow ? { allow: [...auto.allow] } : {}),
              ...(auto.deny ? { deny: [...auto.deny] } : {}),
              ...(auto.environment ? { environment: [...auto.environment] } : {}),
              ...(auto.twoStageMode ? { twoStageMode: auto.twoStageMode } : {}),
            },
          }
        : {}),
    },
    limits: {
      ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
      ...(config.maxStepsPerTurn !== undefined ? { maxStepsPerTurn: config.maxStepsPerTurn } : {}),
    },
  }
}

/**
 * The `auto`-tier judge, one for the whole harness. It runs the model picked in Settings → Operon,
 * else the main-loop model (carried on the authorize ctx), as a Claude-Code-style two-stage security
 * classifier. Only consulted when a session's permission mode is `auto`; a session's workspace
 * rules (`permission.autoApproval`) reach it with each call.
 */
function buildAutoApprover(): AutoApprover {
  const judgeOptions = {
    onOutcome: (r) => {
      // Log EVERY verdict, `allow` included. The judge runs the main-loop model before the
      // tool is allowed to start, so its latency is the tool's "Pending" window in the UI —
      // filtering out the common `allow` made the single biggest source of pre-execution
      // delay completely invisible. `no-relevance` is the cheap path (no model call at all),
      // so keeping it distinct is what tells "the judge was slow" from "the judge never ran".
      const stage = r.stage ? ` stage=${r.stage}` : ''
      const reason = r.reason ? `: ${r.reason}` : ''
      console.log(`[operon] auto-approval ${r.outcome} for ${r.toolName} in ${r.durationMs}ms${stage}${reason}`)
    },
  } satisfies Parameters<typeof createAutoApprover>[0]
  return withAutoReviewModel(
    createAutoApprover(judgeOptions),
    () => getAutoReviewConfig().modelId,
    resolveReviewModel,
    (model) => createAutoApprover({ ...judgeOptions, model }),
  )
}

/**
 * Build the process-wide harness. Carries only what is genuinely global; workDir,
 * MCP servers, permission policy, persona and Runner limits are all per session.
 */
async function buildHarness(): Promise<Harness> {
  await mkdir(EXTENSIONS_DIR, { recursive: true })
  configurePeersHost({
    harness: () => HARNESS_INSTANCE,
    workspaceSetup: async (cwd) => {
      const { root: _root, ...setup } = await resolveWorkspaceSetup(cwd)
      return setup
    },
    defaultModelId: async () => {
      const models = await availableModels()
      return models[0]?.id ?? DEFAULT_MODEL_ID
    },
  })
  // One set of MCP connections per project root, shared by every session open there and kept
  // for a few minutes after the last one closes. Owned by this harness: its `close` below.
  const workspaceMcp = new WorkspaceMcpPool({ oauthService: mcpOAuthService })
  syncModelProviders()
  const stopSyncingProviders = onProviderConfigChange(syncModelProvider)
  const harness = await createLocalHarness({
    // What every session starts from. Passed explicitly so the preset does not read a
    // `config.toml` off the process's cwd: workspace config is per session (resolveWorkspaceSetup).
    config: {
      defaults: {
        model: DEFAULT_MODEL_ID,
        // Operon ships its own workflow orchestration (the `OperonWorkflow` MCP tool):
        // it dispatches to ANY provider rather than the framework's own profiles,
        // runs in the background with SQLite-backed resume, and reports into the
        // workflow panel. Two overlapping tools would leave the model guessing, and
        // picking the builtin one would silently bypass all of that — so withhold it.
        // Narrow on purpose: subagents and the `Agent` tool stay.
        subagents: { workflowTool: false },
      },
    },
    autoApprover: buildAutoApprover(),
    // Every restore the UI does not hand a setup to — a peer message to an unloaded recipient
    // (`host.resumeSession`), any bare `resumeSession(id)` — gets the host's current one for it,
    // laid over what the session stored so its model, mode and extension parameters survive.
    // A restore the UI drives passes its own setup in, merged the same way. The result is final
    // and not stored, so the stored setup stays what the session was created with.
    resolveSession: async (request) => {
      if (request.operation !== 'restore') return
      const current = request.requested.config ?? (await restoredSessionConfig(request.session))
      return { config: resolveSessionConfig(request.stored ?? {}, current) }
    },
    modelManager,
    // File extensions: one folder per extension under `~/.operon/data/extensions`. Nothing
    // there runs until the user loads it from Settings → Extensions. Marketplace downloads are
    // ordinary file extensions; a previous explicit approval is restored below on startup.
    extensionDir: EXTENSIONS_DIR,
    // Host services extensions may `use`. `operon-teams` is what the Teams bundle reads its
    // teammate types from and reports every spawn to.
    services: { [TEAMS_SERVICE]: createTeamsHostService() },
    // Product telemetry: the framework projects every session's turn / tool / compaction events
    // into the process service, which reaches PostHog through the host's consent-gated sink.
    // A headless run has no sink and gets the no-op service.
    telemetry: getTelemetry(),
    // Process-lived parts. Tracing is the only one so far: with `OPERON_TRACING` set, every
    // session's event stream is bridged into OTel spans (see ./tracing.ts); otherwise nothing is
    // added and sessions run exactly as before.
    infrastructure: () => {
      const tracing = createOperonTracing()
      return {
        ...(tracing ? { tracing } : {}),
        close: () => {
          stopSyncingProviders()
          return workspaceMcp.close()
        },
      }
    },
    homeDir: HARNESS_HOME_DIR,
    // Capabilities are built FRESH PER SESSION
    // so per-session state (goal/plan/todo/background/skills/mcp) is isolated. The factory loads
    // the shared global PluginManager, then hands it + THIS session's MCP servers to
    // `defaultCapabilities`, which self-drives the plugin's skills + MCP (merged, namespaced) +
    // session-start into the set. Reading the manager per session means installs/enables take
    // effect on the next chat with no cache eviction.
    sessionCapabilities: async (ctx) => {
      await ensurePluginsLoaded()
      const root = await resolveProjectRoot(ctx.workDir)
      const workspaceServers = await loadWorkspaceMcpServers(root)
      const ownMcp = ctx.config.mcp
      // Shared MCP OAuth token store — a login done from the Plugins UI is reused here, so an
      // OAuth-gated plugin MCP server (e.g. Linear) connects authenticated without re-prompting.
      return defaultCapabilities({
        ownEnvironment: ctx.ownEnvironment,
        pluginManager,
        // The workspace's `mcp.json` servers and the plugins' are borrowed from the project's
        // shared set. `mcp.json` is re-read on every open (a few small files): an edit changes
        // the configuration, and the pool gives the next session a fresh set for it.
        workspaceMcp: { pool: workspaceMcp, workDir: root, servers: workspaceServers },
        // What the session sees: the plugins' and the workspace's servers (borrowed from the pool
        // above) plus its own, which stay private to it and win on a name clash. A session's
        // configuration carries only its own (workspaceSessionConfig); `mcp: false` means none.
        ...(ownMcp === undefined
          ? {}
          : { mcp: ownMcp === false ? false : { servers: { ...pluginManager.mcpServerConfigs(), ...workspaceServers, ...ownMcp.servers } } }),
        oauthService: mcpOAuthService,
      })
    },
    // Code Mode in its default role (`hide: "catalog"`): the fallback for deferred tool loading.
    // A model that can take tools mid-conversation (Claude on Anthropic Messages, see
    // resolve-model.ts) keeps SearchTool and never sees RunCode. Every other model would
    // otherwise get every MCP tool up front, which a few plugins are enough to blow its context
    // with: those tools leave the request, RunCode declares a budgeted slice of them and the
    // program finds the rest with `searchTools`. Built-in tools stay direct. Nested calls come
    // out as ordinary tool parts (message-mapper) and render inside the program's card.
    extensions: [codeMode()],
    // Only override the tool registry when extras are registered; otherwise omit it
    // so the harness keeps its exact default (`filesystemTools()` + AskUserQuestion). When the
    // bench registers memory tools, re-add the builtin coding tools alongside.
    ...(registeredExtraTools.length > 0
      ? { registry: { tools: [...filesystemTools(), ...registeredExtraTools] } }
      : {}),
  })
  // A session restored without going through `openSession` (a peer message to an unloaded
  // recipient) is observed before its first run, so that run's transcript reaches its chat row.
  harness.onSessionOpened((session, info) => {
    if (info.operation !== 'restore') return
    const row = getChatStorage()?.findChatBySessionId(session.id)
    observeSession(session, { notifyOnTurnEnd: row?.tp !== 'teammate' })
  })
  HARNESS_INSTANCE = harness
  startSessionWatch(harness)
  await loadApprovedExtensions(harness)
  // Then, off the launch path, catch the extensions up with the marketplace. Chained onto
  // `HARNESS` rather than started here: the sync reads the marketplace through
  // `listMarketplaceExtensions`, which calls `getOperonHarness()` — awaiting the very promise
  // this function is still resolving. Waiting for it to settle first is what keeps that from
  // being a deadlock.
  void HARNESS?.then((built) => syncApprovedExtensions(built)).catch(() => undefined)
  return harness
}

/**
 * Runtime provider backed by the in-process `operon-agents` engine (our own framework).
 * Replaces the hand-rolled aisdk `custom` loop: real session tree, capabilities
 * (goal / plan / todo / skills / cron / background / compaction), and the builtin
 * coding toolset (read/write/edit/glob/grep/bash).
 */
export class OperonRuntimeProvider implements RuntimeProviderFactory<SessionOptions, OperonSessionNative> {
  static readonly providerInfo: ProviderInfo = { id: 'custom', label: 'Operon', logo: 'custom' }
  readonly providerInfo = OperonRuntimeProvider.providerInfo

  private currentModelId = DEFAULT_MODEL_ID
  private currentModeId = 'manual'
  private currentThinkingLevel: string | undefined

  /**
   * The harness backing every Operon chat.
   *
   * Everything workspace- or conversation-specific rides the session itself, so one
   * harness serves them all — which is the whole point. A harness carries the agent
   * profile, tool palette, plugins, skills and MCP connections; it used to be rebuilt
   * per conversation purely because the injected MCP map named the conversation,
   * which meant a fresh set of MCP connections for every chat and again after every
   * session rebuild.
   */
  private harness(): Promise<Harness> {
    return getOperonHarness()
  }

  async getDescriptor(): Promise<ProviderDescriptor> {
    const models = await availableModels()
    if (models.length > 0 && !models.some((m) => m.id === this.currentModelId)) {
      this.currentModelId = models[0]!.id
    }
    return {
      id: 'custom',
      label: 'Operon',
      logo: 'custom',
      models,
      modes: [
        { id: 'manual', name: 'Manual', description: 'Ask before writes and shell commands' },
        { id: 'workspace', name: 'Workspace', description: 'Auto-approve inside the workspace; still ask for writes outside it, secrets, and .git' },
        { id: 'auto', name: 'Auto', description: 'A model judges each action and only asks you when it looks risky' },
        { id: 'yolo', name: 'YOLO', description: 'Approve everything with no prompts' },
      ],
      commands: [],
      skills: [],
      slashCommands: [
        { name: 'compact', description: 'Compact conversation history', type: 'command' },
        { name: 'plan', description: 'Toggle plan mode (on / off / show)', type: 'command' },
      ],
      thinkingLevels: THINKING_LEVELS,
      currentModelId: this.currentModelId,
      currentModeId: this.currentModeId,
      currentThinkingLevel: this.currentThinkingLevel,
      features: {
        permissions: true,
        attachments: true,
        injection: true,
        steer: true,
        followup: true,
        sessionResume: true,
        goal: true,
        dynamicSwitch: true,
        contextUsage: true,
      },
    }
  }

  /**
   * The model to run when the caller names none. Falls back to the first model the
   * user has actually configured instead of insisting on `DEFAULT_MODEL_ID`, whose
   * provider may have no API key at all (see `isProviderConfigured`).
   */
  private async defaultModelId(): Promise<string> {
    if (isProviderConfigured(this.currentModelId)) return this.currentModelId
    const models = await availableModels()
    return models[0]?.id ?? this.currentModelId
  }

  async createSession(params: SessionOptions): Promise<OperonRuntimeSession> {
    const modelId = params.model ?? (await this.defaultModelId())
    const modeId = params.mode ?? this.currentModeId
    this.currentModelId = modelId
    this.currentModeId = modeId
    if (params.effort !== undefined) this.currentThinkingLevel = params.effort

    const session = await this.openSession(params.resume, params.cwd, params.mcpServers, params.instructions)
    session.setModel(modelRef(modelId))
    session.setPermissionMode(MODE_TO_PERMISSION[modeId] ?? 'manual')
    // Only the models that advertise the level will surface it in the picker, so a
    // present value is safe to apply; absent = leave the model's default thinking.
    if (params.effort) session.setThinking(params.effort as EngineThinkingLevel)

    return new OperonRuntimeSession(session, modelId, modeId)
  }

  /** Restore the requested history, or explicitly create a new conversation when no id is given. */
  private async openSession(
    sessionId: string | undefined,
    cwd: string,
    mcpServers?: RuntimeMcpServers,
    instructions?: string,
  ): Promise<HarnessSession> {
    const harness = await this.harness()
    if (sessionId !== undefined) {
      return resumeRuntimeSession(harness, sessionId, async () =>
        workspaceSessionConfig(await resolveWorkspaceSetup(cwd, mcpServers), instructions))
    }
    const { root, ...setup } = await resolveWorkspaceSetup(cwd, mcpServers)
    const session = await harness.createSession({ workDir: root, config: workspaceSessionConfig(setup, instructions) })
    observeSession(session, { notifyOnTurnEnd: true })
    return session
  }
}

/** Operon's own in-process agent, registered next to the external CLIs under the id `custom`. */
export const operonAgent = () =>
  defineProvider<'custom', { sessionNative: OperonSessionNative }>({
    id: 'custom',
    info: OperonRuntimeProvider.providerInfo,
    create: () => new OperonRuntimeProvider(),
  })
