import path from 'path'
import { stat } from 'fs/promises'
import { createLocalHarness, defaultCapabilities, filesystemTools, LlmAutoApprover, LocalMachine, resolveFromFiles, toCoreOptions, type AutoApprovalOptions, type Harness, type HarnessSession, type McpServerConfig, type PermissionManagerOptions, type PermissionMode, type PermissionRule, type ThinkingLevel as EngineThinkingLevel, type Tool } from 'operon-agents'
import { loadMcpServers } from 'operon-agents/mcp'
import { fetchProviderModels, getProviderConfigs, PROVIDER_META } from '../provider-config.js'
import type {
  Model,
  ProviderDescriptor,
  ProviderInfo,
  RuntimeProviderFactory,
  RuntimeMcpServers,
  RuntimeSession,
  RuntimeSessionParams,
  ThinkingLevel,
} from '@operon/agent-runtime'
import { getModelCapabilities, resolveModel } from './resolve-model.js'
import { MODE_TO_PERMISSION, OperonRuntimeSession } from './session.js'
import { HARNESS_HOME_DIR } from './paths.js'
import { ensurePluginsLoaded, pluginManager } from './plugins.js'
import { mcpOAuthService } from './mcp-oauth.js'

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
// `getSessionId()` ↔ DB record and feeds it back as `params.sessionId` to resume.
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
    const { servers } = await loadMcpServers(new LocalMachine(root), { appName: APP_NAME, cwd: root })
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
    const { config } = await resolveFromFiles({ appName: APP_NAME, cwd: root })
    const core = toCoreOptions(config)
    return {
      permission: core.permission,
      ...(core.loopControl.maxTurns !== undefined ? { maxTurns: core.loopControl.maxTurns } : {}),
      ...(core.loopControl.maxStepsPerTurn !== undefined ? { maxStepsPerTurn: core.loopControl.maxStepsPerTurn } : {}),
    }
  } catch (error) {
    console.warn(`[operon] failed to load config.toml under ${root}: ${error instanceof Error ? error.message : String(error)}`)
    return { permission: { rules: [] } }
  }
}

// Thinking effort options offered in the picker. The UI filters these by each
// model's `supportedEffortLevels`, so unsupported levels are hidden per model. The
// id is sent back as `params.thinkingLevel` and applied via `session.setThinking`.
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
  // ollama is local — it needs no key, just an endpoint.
  return providerId === 'ollama' || Boolean(config.apiKey)
}

async function availableModels(): Promise<Model[]> {
  const all = getProviderConfigs()
  const results: Model[] = []
  await Promise.all(
    Object.entries(all).map(async ([providerId, config]) => {
      if (!config.enabled) return
      if (!config.apiKey && providerId !== 'ollama') return
      const meta = PROVIDER_META[providerId]
      const seen = new Set<string>()
      const push = (model: { id: string; name: string; description?: string }) => {
        const id = `${providerId}/${model.id}`
        if (seen.has(id)) return
        seen.add(id)
        results.push({
          ...model,
          id,
          providerId,
          providerLabel: meta?.label ?? providerId,
          providerLogo: providerId,
          supportedEffortLevels: getModelCapabilities(id).effortLevels,
        })
      }
      // Hand-entered model IDs first — these must show even when the provider has
      // no "list models" endpoint (or the live fetch below fails).
      for (const id of config.manualModels ?? []) push({ id, name: id })
      try {
        const models = await fetchProviderModels(providerId)
        for (const model of models) push(model)
      } catch {
        // ignore unavailable providers
      }
    }),
  )
  return results
}

/** Runner limits from a workspace's config.toml, applied per session. */
interface WorkspaceRunnerLimits {
  maxTurns?: number
  maxStepsPerTurn?: number
}

interface WorkspaceSetup {
  workspaceServers: Record<string, McpServerConfig>
  permission: PermissionManagerOptions
  limits: WorkspaceRunnerLimits
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

/** `mcp.json` + `config.toml` per project root — read once, reused by every session there. */
const WORKSPACE_SETUPS = new Map<string, Promise<WorkspaceSetup>>()

async function loadWorkspaceSetup(root: string): Promise<WorkspaceSetup> {
  const [workspaceServers, config] = await Promise.all([loadWorkspaceMcpServers(root), loadWorkspaceConfig(root)])
  // The `auto`-tier judge. It runs the main-loop model (carried on the authorize ctx) as a
  // Claude-Code-style two-stage security classifier; the workspace's config.toml can extend the
  // allow/deny/environment sections. Injected unconditionally but only consulted when the
  // session's permission mode is `auto`.
  const auto = config.permission.autoApproval
  const autoApprover = new LlmAutoApprover({
    rules: { allow: auto?.allow, deny: auto?.deny, environment: auto?.environment },
    ...(auto?.twoStageMode ? { twoStageMode: auto.twoStageMode } : {}),
    onOutcome: (r) => {
      if (r.outcome !== 'allow' && r.outcome !== 'no-relevance') {
        console.log(`[operon] auto-approval ${r.outcome} for ${r.toolName}${r.reason ? `: ${r.reason}` : ''}`)
      }
    },
  })
  return {
    workspaceServers,
    // config.toml owns the permission rules; the UI mode picker still overrides the
    // mode per-session via `setPermissionMode`.
    permission: { mode: config.permission.mode ?? 'yolo', rules: config.permission.rules, autoApprover },
    limits: {
      ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
      ...(config.maxStepsPerTurn !== undefined ? { maxStepsPerTurn: config.maxStepsPerTurn } : {}),
    },
  }
}

/**
 * Build the process-wide harness. Carries only what is genuinely global; workDir,
 * MCP servers, permission policy, persona and Runner limits are all per session.
 */
async function buildHarness(): Promise<Harness> {
  return createLocalHarness({
    model: DEFAULT_MODEL_ID,
    resolveModel,
    // A default only — every session passes its own workDir, and the engine builds
    // that session's `LocalMachine` from it.
    workDir: process.cwd(),
    homeDir: HARNESS_HOME_DIR,
    // Capabilities are built FRESH PER SESSION (a factory) so per-session state (goal/plan/todo/
    // background/skills/mcp) is isolated. The factory loads the shared global PluginManager, then
    // hands it + THIS session's MCP servers to `defaultCapabilities`, which self-drives the
    // plugin's skills + MCP (merged, namespaced) + session-start into the set. Reading the manager
    // per session means installs/enables take effect on the next chat with no cache eviction.
    capabilities: async (ctx) => {
      await ensurePluginsLoaded()
      // Shared MCP OAuth token store — a login done from the Plugins UI is reused here, so an
      // OAuth-gated plugin MCP server (e.g. Linear) connects authenticated without re-prompting.
      return defaultCapabilities({
        pluginManager,
        mcpServers: ctx.mcpServers ?? {},
        oauthService: mcpOAuthService,
      })
    },
    // Operon ships its own workflow orchestration (the `OperonWorkflow` MCP tool):
    // it dispatches to ANY provider rather than the framework's own profiles,
    // runs in the background with SQLite-backed resume, and reports into the
    // workflow panel. Two overlapping tools would leave the model guessing, and
    // picking the builtin one would silently bypass all of that — so withhold it.
    // Narrow on purpose: subagents and the `Agent` tool stay.
    workflowTool: false,
    // Only override `tools` when extras are registered; otherwise omit the key
    // so the harness keeps its exact default (`filesystemTools()`). When the
    // bench registers memory tools, re-add the builtin coding tools alongside.
    ...(registeredExtraTools.length > 0
      ? { tools: [...filesystemTools(), ...registeredExtraTools] }
      : {}),
  })
}

/**
 * Runtime provider backed by the in-process `operon-agents` engine (our own framework).
 * Replaces the hand-rolled aisdk `custom` loop: real session tree, capabilities
 * (goal / plan / todo / skills / cron / background / compaction), and the builtin
 * coding toolset (read/write/edit/glob/grep/bash).
 */
export class OperonRuntimeProvider implements RuntimeProviderFactory {
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
    if (!HARNESS) {
      // Clear a failed build so a transient error doesn't poison the process.
      HARNESS = buildHarness().catch((error) => {
        HARNESS = undefined
        throw error
      })
    }
    return HARNESS
  }

  /**
   * Resolve everything a session needs from its workspace: the project root, the
   * MCP servers to expose (workspace `mcp.json` merged under the host-injected,
   * conversation-scoped ones) and the permission policy from `config.toml`.
   *
   * Read per session rather than per harness — that is what lets the harness be
   * shared. Cached by root so this stays one filesystem read per workspace.
   */
  private async resolveWorkspaceSetup(
    cwd: string,
    injectedMcpServers?: RuntimeMcpServers,
  ): Promise<{
    root: string
    servers: Record<string, McpServerConfig>
    permission: PermissionManagerOptions
    limits: WorkspaceRunnerLimits
  }> {
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
      // Host-injected servers win: they carry the conversation's own identity
      // (node_repl's kernel, the workflow/taskboard scope) and must not be masked
      // by a same-named workspace entry.
      servers: { ...setup.workspaceServers, ...(injectedMcpServers as Record<string, McpServerConfig> | undefined) },
      permission: setup.permission,
      limits: setup.limits,
    }
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

  async createSession(params: RuntimeSessionParams): Promise<RuntimeSession> {
    const modelId = params.modelId ?? (await this.defaultModelId())
    const modeId = params.modeId ?? this.currentModeId
    this.currentModelId = modelId
    this.currentModeId = modeId
    if (params.thinkingLevel !== undefined) this.currentThinkingLevel = params.thinkingLevel

    const session = await this.openSession(params.sessionId, params.cwd, params.mcpServers, params.instructions)
    session.setModel(await resolveModel(modelId))
    session.setPermissionMode(MODE_TO_PERMISSION[modeId] ?? 'manual')
    // Only the models that advertise the level will surface it in the picker, so a
    // present value is safe to apply; absent = leave the model's default thinking.
    if (params.thinkingLevel) session.setThinking(params.thinkingLevel as EngineThinkingLevel)

    return new OperonRuntimeSession(session, modelId, modeId)
  }

  /**
   * Resume the chat's persisted session when the route supplies its id, else start
   * a fresh one. A missing/stale id (store cleared, fork lost) falls back to fresh
   * rather than failing the turn — the chat keeps working, just without old context.
   */
  private async openSession(
    sessionId: string | undefined,
    cwd: string,
    mcpServers?: RuntimeMcpServers,
    instructions?: string,
  ): Promise<HarnessSession> {
    const { root, servers, permission, limits } = await this.resolveWorkspaceSetup(cwd, mcpServers)
    const harness = await this.harness()
    // Everything that used to be baked into a per-conversation harness travels with
    // the session instead, so all chats share one harness (and its MCP connections
    // for the workspace's own servers).
    const opts = {
      mcpServers: servers,
      permission,
      ...limits,
      ...(instructions?.trim() ? { appendSystemPrompt: instructions.trim() } : {}),
    }
    if (sessionId) {
      try {
        return await harness.resumeSession(sessionId, opts)
      } catch {
        // fall through to a fresh session
      }
    }
    return harness.createSession({ workDir: root, ...opts })
  }
}
