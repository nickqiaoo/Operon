import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { mkdirSync } from 'fs'
import {
  createLocalHarness,
  defaultCapabilities,
  defineAgent,
  filesystemTools,
  LlmAutoApprover,
  LocalEnvironment,
  type Agent,
  type Capability,
  type Harness,
  type HarnessSession,
  type ImageContent,
  type McpServerConfig,
  type PermissionManagerOptions,
  type TextContent,
} from 'operon-agents'
import { loadMcpServers } from 'operon-agents/mcp'
import type {
  Activity,
  AssistantAttachment,
  AssistantConfig,
  AssistantEvent,
  AssistantMessage,
  AssistantState,
  ProfileFile,
  ProfileFileName,
} from '../../../../shared/assistant.js'
import type { ApprovalIcon, AuditRecord } from '../../../../shared/assistant.js'
import type { AssistantStorageAdapter, CronjobStorageAdapter, StorageAdapter } from '../../storage/interface.js'
import type { CronjobTask } from '../../types/cronjob.js'
import type { AssistantCronRunner } from '../cronjob.js'
import {
  cachedComputerUseApproval,
  forgetSessionComputerUseApprovals,
  rememberComputerUseApproval,
  type HostElicitationRequest,
  type HostElicitationResult,
} from '../ai/host-approval-broker.js'
import { shouldAutoReviewBrowserOrigin } from '../ai/host-elicitation.js'
import { getBrowserUseConfig } from '../browser-use-config.js'
import { getChromeUseConfig } from '../chrome-use-config.js'
import { getComputerUseConfig } from '../computer-use-config.js'
import { withApiToken } from '../mcp-config.js'
import { listOperonModels } from '../operon-runtime/index.js'
import { mcpOAuthService } from '../operon-runtime/mcp-oauth.js'
import { ensurePluginsLoaded, pluginManager } from '../operon-runtime/plugins.js'
import { resolveModel } from '../operon-runtime/resolve-model.js'
import { ensureProfileFiles, listProfileFiles, parseIdentity, readProfileFile, watchProfileFiles, writeProfileFile } from './files.js'
import { ASSISTANT_HARNESS_HOME, ASSISTANT_WORKSPACE } from './paths.js'
import { AssistantApprovals, type ApprovalAnswer } from './approvals.js'
import { buildUserInput } from './attachments.js'
import { AssistantGrants, grantKeyForElicitation, grantKeyForTool } from './grants.js'
import { assistantNodeReplQuery, setAssistantElicitationHandler } from './node-repl-bridge.js'
import { AssistantProjector, record, summaryLine } from './projector.js'
import {
  buildHeartbeatInstructions,
  buildHeartbeatPrompt,
  buildMainInstructions,
  buildScheduledPrompt,
  buildWorkerInstructions,
  buildWrapUpInstructions,
  type WorkerSurfaces,
} from './prompts.js'
import { buildSessionSeed, buildWrapUpTranscript, ContextReminder, rotationDue } from './rotation.js'
import { AssistantSchedules, cadenceOf, heartbeatHasWork, inQuietHours, removeLines } from './schedule.js'
import {
  continueTaskTool,
  finishTaskTool,
  heartbeatDoneTool,
  listTasksTool,
  mainScopeCapability,
  memorySearchTool,
  profileEditTool,
  reportProgressTool,
  scheduleTools,
  setIdentityTool,
  startTaskTool,
  stopTaskTool,
  workerScopeCapability,
  type AssistantToolHost,
} from './tools.js'
import { WorkerPool, workerOfSession, type WorkerKind, type WorkerOutcome } from './workers.js'

type Storage = StorageAdapter & AssistantStorageAdapter & CronjobStorageAdapter

const CONFIG_KEY = 'assistant:config'
const SESSION_KEY = 'assistant:session_id'
/** When the current main session started — it is renewed daily (rotation.ts). */
const STARTED_KEY = 'assistant:session_started_at'
/** What the current main session was told about the conversation before it. */
const SEED_KEY = 'assistant:session_seed'
/** Session ids of one-off helpers that are neither the main agent nor a worker (the wrap-up). */
const UTILITY_PREFIX = 'au-'
const LOCALE_KEY = 'assistant:ui_locale'
/** What the heartbeat has told the user lately, so it does not say it twice. */
const HEARTBEAT_TOLD_KEY = 'assistant:heartbeat_told'
/** Findings held back during quiet hours, said at the first check after. */
const HEARTBEAT_HELD_KEY = 'assistant:heartbeat_held'
const TOLD_KEPT = 12
const TOLD_TTL_MS = 3 * 24 * 60 * 60_000
const QUIET_DEFAULT = { quietStart: '23:00', quietEnd: '08:00' }
const PAGE_SIZE = 200
const NO_MODEL = 'No model is set up for the assistant yet. Add a provider in Settings → AI Providers, then pick models in Settings → Assistant.'
const ONBOARDING_KICK = '(The user just opened the assistant for the first time. Start the first meeting.)'

function filesRecord(): Record<ProfileFileName, ProfileFile> {
  const files = listProfileFiles()
  return Object.fromEntries(files.map((f) => [f.name, f])) as Record<ProfileFileName, ProfileFile>
}

/** The user's own MCP servers (`~/.operon/mcp.json` family). Plugins' servers come via the plugin manager. */
async function loadUserMcpServers(): Promise<Record<string, McpServerConfig>> {
  try {
    const { servers } = await loadMcpServers(new LocalEnvironment(ASSISTANT_WORKSPACE), { appName: 'operon', cwd: ASSISTANT_WORKSPACE })
    return servers
  } catch (error) {
    console.warn('[assistant] failed to load MCP config:', error)
    return {}
  }
}

/** The Settings switches that gate node_repl, same as for chats (mcp-config.ts). */
function workerSurfaces(): WorkerSurfaces {
  return {
    browser: getBrowserUseConfig().enabled,
    chrome: getChromeUseConfig().enabled,
    computer: getComputerUseConfig().enabled,
  }
}

/** How a node_repl permission prompt reads on a card. */
function describeElicitation(request: HostElicitationRequest): { title: string; icon: ApprovalIcon; args?: Record<string, unknown> } {
  const meta = record(request.meta)
  const connector = typeof meta.connector_name === 'string' ? meta.connector_name : typeof meta.connector_id === 'string' ? meta.connector_id : ''
  const action = typeof meta.tool_title === 'string' ? meta.tool_title : ''
  const origin = typeof meta.origin === 'string' ? meta.origin : ''
  const title = [connector, [action, origin].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || request.message
  const icon: ApprovalIcon =
    meta.file_transfer ? 'file' : meta.connector_id === 'computer-use' ? 'app' : connector ? 'globe' : 'tool'
  const params = record(meta.tool_params)
  return { title, icon, ...(Object.keys(params).length ? { args: params } : {}) }
}

/** Where a worker's "Allow once" on Computer Use is remembered: its own run, nobody else's. */
function approvalScope(workerId: string): string {
  return `assistant:${workerId}`
}

type MainOrigin = Parameters<HarnessSession['steerTo']>[2]
type ApprovalHandler = NonNullable<Parameters<HarnessSession['setApprovalHandler']>[0]>

/** Longest worker result the main agent is handed in a notice; the drawer shows all of it. */
const NOTICE_RESULT_LIMIT = 6_000
const LISTED_TASKS = 10

const END_LABEL: Record<WorkerOutcome['end'], string> = {
  completed: 'finished',
  failed: 'failed',
  stopped: 'stopped by the user',
  timed_out: 'ran out of time and was stopped',
}

/**
 * The personal assistant: one long-lived framework session for the main agent (the one the
 * user talks to), plus a session per worker, folded into a single on-screen thread and an
 * Activity list. See docs/assistant/design.md.
 *
 * Runs its own harness, separate from the coding chats': different agents, a tool scope per
 * kind of session, and no workspace.
 */
export class AssistantRuntime {
  private readonly bus = new EventEmitter()
  private readonly projector: AssistantProjector
  private readonly approvals: AssistantApprovals
  private readonly workers: WorkerPool
  private readonly schedules: AssistantSchedules
  private readonly grants: AssistantGrants
  /** The harness's permission policy, kept to open worker sessions with standing grants added. */
  private permissionBase: PermissionManagerOptions | undefined
  private harness: Promise<Harness> | undefined
  private session: HarnessSession | undefined
  private sessionPromise: Promise<HarnessSession> | undefined
  /** Detaches the thread projector from the current main session. */
  private detachMain: (() => void) | undefined
  private rotating: Promise<HarnessSession> | undefined
  /** Per main session: its system prompt, built once, and what it has been told since. */
  private readonly mainContexts = new Map<string, { instructions?: string; reminder: ContextReminder }>()
  /** Read whenever a worker's agent is built, so a changed worker model applies to the next one. */
  private workerModel = ''
  private typing = false
  private onboardingKicked = false

  constructor(private readonly storage: Storage) {
    this.bus.setMaxListeners(50)
    ensureProfileFiles()
    mkdirSync(ASSISTANT_WORKSPACE, { recursive: true })

    // Workers live inside this process; whatever was running when it last stopped is gone.
    for (const a of storage.assistantActivityList(PAGE_SIZE)) {
      if (a.status !== 'running' && a.status !== 'waiting') continue
      storage.assistantActivityUpsert({
        ...a,
        status: 'stopped',
        summary: 'Interrupted when the app restarted',
        finishedAt: a.finishedAt ?? Date.now(),
        steps: a.steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed' as const } : s)),
      })
    }

    this.projector = new AssistantProjector(
      {
        message: (message) => {
          storage.assistantMessageUpsert(message)
          this.emit({ type: 'message', message })
        },
        typing: (typing) => {
          this.typing = typing
          this.emit({ type: 'typing', typing })
        },
      },
      () => randomUUID(),
    )

    this.workers = new WorkerPool(
      {
        harness: () => this.ensureHarness(),
        agent: (id, kind) => this.workerAgent(id, kind),
        permission: () =>
          this.permissionBase && { ...this.permissionBase, rules: [...(this.permissionBase.rules ?? []), ...this.grants.toolRules()] },
        activity: (activity) => this.saveActivity(activity),
        stored: (id) => storage.assistantActivityGet(id) ?? undefined,
        approvalHandler: (id) => (request) => this.onWorkerApproval(id, request),
        settled: (outcome) => this.onWorkerSettled(outcome),
      },
      () => randomUUID(),
    )

    this.approvals = new AssistantApprovals(
      {
        card: (messageId, approval, createdAt) => {
          const message: AssistantMessage = {
            id: messageId,
            role: 'assistant',
            text: '',
            createdAt,
            approval,
            ...(approval.activityId ? { activityId: approval.activityId } : {}),
          }
          storage.assistantMessageUpsert(message)
          this.emit({ type: 'message', message })
        },
        audit: (entry) => this.audit(entry),
        setWaiting: (activityId, waiting) => this.workers.setWaiting(activityId, waiting),
      },
      () => randomUUID(),
    )
    // Workers' node_repl prompts (new site, app control) come here instead of a chat's card.
    setAssistantElicitationHandler((workerId, request) => this.onElicitation(workerId, request))

    watchProfileFiles((file) => {
      this.onProfileChanged(file.name, false)
      this.emit({ type: 'file', file })
    })

    this.schedules = new AssistantSchedules(storage, (schedules) => this.emit({ type: 'schedules', schedules }))
    this.grants = new AssistantGrants(storage, (grants) => this.emit({ type: 'grants', grants }), () => randomUUID())
    // The heartbeat starts with the assistant's first use, and is always on from then on.
    this.schedules.ensureHeartbeat()
  }

  private saveActivity(activity: Activity): void {
    this.storage.assistantActivityUpsert(activity)
    this.emit({ type: 'activity', activity })
  }

  private audit(entry: AuditRecord): void {
    this.storage.assistantAuditInsert(entry)
    this.emit({ type: 'audit', record: entry })
  }

  /** The user's latest words in the thread — taken when a worker is sent out or picked back up. */
  private latestUserText(): string {
    const recent = this.storage.assistantMessageList({ limit: 30 })
    return [...recent].reverse().find((m) => m.role === 'user')?.text ?? ''
  }

  private async onElicitation(workerId: string, request: HostElicitationRequest): Promise<HostElicitationResult> {
    // The Settings the chats share (block list, apps allowed for good there), then what the user
    // allowed for this task. That cache is per worker: shared by the whole assistant, one "Allow
    // once" would have held for every later worker until a restart, unattended runs included.
    const cached = cachedComputerUseApproval(approvalScope(workerId), request)
    if (cached) return cached
    const { title, icon, args } = describeElicitation(request)
    const entry = { title, detail: request.message, icon, activityId: workerId, ...(args ? { args } : {}) }
    // Something the user said "Always allow" to — for unattended runs too: they trusted it.
    const grant = this.grants.forElicitation(request)
    if (grant) {
      this.audit({ id: randomUUID(), ...entry, detail: `Always allowed: ${grant.title}`, decision: 'auto_allowed', at: Date.now() })
      return { action: 'accept', _meta: { persist: 'session' } }
    }
    // A site the user named in their request needs no extra click — same rule as chats. Judged
    // against the words this worker was sent out on, not whatever the user said in the thread
    // since: a site mentioned later about something else must not open up an earlier task.
    if (!this.workers.isUnattended(workerId) && shouldAutoReviewBrowserOrigin(request, this.workers.askedFor(workerId))) {
      this.audit({ id: randomUUID(), ...entry, decision: 'auto_allowed', at: Date.now() })
      return { action: 'accept', _meta: { approvals_reviewer: 'auto_review' } }
    }
    // Nobody is watching a heartbeat or a scheduled run: skip the step, the result says so.
    if (this.workers.isUnattended(workerId)) {
      this.audit({ id: randomUUID(), ...entry, detail: `Skipped while running unattended: ${request.message}`, decision: 'denied', at: Date.now() })
      return { action: 'decline' }
    }
    const answer = await this.approvals.request(entry)
    if (answer === 'denied') return { action: 'decline' }
    if (answer === 'expired') return { action: 'cancel' }
    // "Allow once" covers this task: Computer Use asks before every action, so it is remembered
    // for this worker's run, as the kernel remembers a site for this worker's context.
    rememberComputerUseApproval(approvalScope(workerId), request, 'session')
    // The assistant's own "always" goes on its list (grants.ts), not into the settings chats share.
    if (answer === 'always_allowed') {
      const key = grantKeyForElicitation(request)
      if (key) this.grants.add(key)
    }
    return { action: 'accept', _meta: { persist: 'session' } }
  }

  /** The `auto` judge escalated one of a worker's tool calls. */
  private async onWorkerApproval(activityId: string, request: Parameters<ApprovalHandler>[0]): Promise<Awaited<ReturnType<ApprovalHandler>>> {
    const display = record(request.display)
    const label = typeof display.title === 'string' && display.title.trim() ? display.title.trim() : request.toolName
    const detail = `${request.toolName}${request.approvalRule && request.approvalRule !== request.toolName ? ` — ${request.approvalRule}` : ''}`
    const icon = request.toolName === 'Bash' ? 'terminal' : request.toolName.startsWith('mcp__') ? 'tool' : 'file'
    const key = grantKeyForTool(request.toolName, request.approvalRule)
    // Sessions opened after the grant have it as an allow rule; one already running asks here.
    const grant = this.grants.find(key.kind, key.value)
    if (grant) {
      this.audit({ id: randomUUID(), title: label, detail: `Always allowed: ${grant.title}`, icon, decision: 'auto_allowed', at: Date.now(), activityId })
      return { decision: 'approved', scope: 'session' }
    }
    if (this.workers.isUnattended(activityId)) {
      this.audit({ id: randomUUID(), title: label, detail: `Skipped while running unattended: ${detail}`, icon, decision: 'denied', at: Date.now(), activityId })
      return {
        decision: 'rejected',
        feedback: 'This step needs the user\'s approval and nobody is watching this run. Skip it and say in your result what you could not do and why.',
      }
    }
    const answer = await this.approvals.request({ title: label, detail, icon, activityId })
    if (answer === 'allowed_once') return { decision: 'approved' }
    if (answer === 'always_allowed') {
      this.grants.add(key)
      return { decision: 'approved', scope: 'session' }
    }
    if (answer === 'denied') return { decision: 'rejected', feedback: 'The user declined this step.' }
    return { decision: 'cancelled' }
  }

  /** The user answered an approval card. */
  answerApproval(id: string, decision: Exclude<ApprovalAnswer, 'expired'>): boolean {
    return this.approvals.answer(id, decision)
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  subscribe(listener: (event: AssistantEvent) => void): () => void {
    this.bus.on('event', listener)
    return () => this.bus.off('event', listener)
  }

  private emit(event: AssistantEvent): void {
    this.bus.emit('event', event)
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  getConfig(): AssistantConfig {
    const stored = this.storage.get<Partial<AssistantConfig>>(CONFIG_KEY) ?? {}
    return {
      mainModel: stored.mainModel ?? '',
      workerModel: stored.workerModel ?? '',
      quietStart: stored.quietStart ?? QUIET_DEFAULT.quietStart,
      quietEnd: stored.quietEnd ?? QUIET_DEFAULT.quietEnd,
    }
  }

  /** The configured models, with blanks filled from what the user has set up. */
  private async effectiveConfig(): Promise<AssistantConfig & { blocker?: string }> {
    const config = this.getConfig()
    if (config.mainModel && config.workerModel) return config
    const models = await listOperonModels().catch(() => [])
    const fallback = models[0]?.id ?? ''
    const mainModel = config.mainModel || fallback
    const workerModel = config.workerModel || fallback
    return { ...config, mainModel, workerModel, ...(mainModel && workerModel ? {} : { blocker: NO_MODEL }) }
  }

  setConfig(patch: Partial<AssistantConfig>): AssistantConfig {
    const next = { ...this.getConfig(), ...patch }
    this.storage.set(CONFIG_KEY, next)
    if (next.workerModel) this.workerModel = next.workerModel
    // Takes effect on the main agent's next turn; a turn already running keeps its model.
    if (next.mainModel && this.session) this.session.setModel(next.mainModel)
    this.emit({ type: 'config', config: next })
    return next
  }

  // ---------------------------------------------------------------------------
  // Harness and sessions
  // ---------------------------------------------------------------------------

  private readonly toolHost: AssistantToolHost = {
    startTask: async ({ title, prompt }, toolCallId) => {
      const { id } = await this.workers.start({ kind: 'task', title, prompt, unattended: false, visible: true, asked: this.latestUserText() })
      this.projector.dispatch(toolCallId, id)
      return id
    },
    // The main agent's message is its own rewording; the user's words are what it acts on.
    continueTask: (id, message) => this.workers.continue(id, message, this.latestUserText()),
    stopTask: (id) => this.stopActivity(id),
    listTasks: () =>
      this.storage
        .assistantActivityList(LISTED_TASKS)
        .map((a) => ({ id: a.id, title: a.title, status: a.status, summary: a.summary })),
    progress: (activityId, text) =>
      this.tellMain(`[Progress from task ${activityId}] ${text}`, {
        kind: 'external',
        source: 'worker-progress',
        metadata: { activityId },
        channel: 'steering',
      }),
    onRemembered: (line) => this.projector.remember(line),
    onFileWritten: (name) => {
      this.onProfileChanged(name, true)
      this.emit({ type: 'file', file: readProfileFile(name) })
    },
  }

  /** Services the heartbeat can look at: the user's MCP servers and the plugins' (node_repl is a tool, not a service). */
  private async connectors(): Promise<string[]> {
    const names = new Set([...Object.keys(await loadUserMcpServers()), ...Object.keys(pluginManager.mcpServerConfigs())])
    names.delete('node_repl')
    return [...names].sort()
  }

  /** Names for the heartbeat's instructions, read when its agent is built (once per run). */
  private heartbeatConnectors: string[] = []

  /** A worker's agent: built per worker, so its tools can name it, and on the current worker model. */
  private workerAgent(activityId: string, kind: WorkerKind): Agent {
    const model = this.workerModel ? { model: this.workerModel } : {}
    if (kind === 'heartbeat') {
      const connectors = this.heartbeatConnectors
      return defineAgent({
        name: 'heartbeat',
        ...model,
        instructions: () => buildHeartbeatInstructions(filesRecord(), connectors),
        tools: [...filesystemTools(), heartbeatDoneTool],
      })
    }
    const unattended = kind === 'schedule'
    return defineAgent({
      name: 'worker',
      ...model,
      instructions: () => buildWorkerInstructions(filesRecord(), { surfaces: workerSurfaces(), unattended }),
      tools: [...filesystemTools(), finishTaskTool, ...(unattended ? [] : [reportProgressTool(this.toolHost, activityId)])],
    })
  }

  private ensureHarness(): Promise<Harness> {
    this.harness ??= this.effectiveConfig()
      .then((config) => {
        if (config.blocker) throw new Error(config.blocker)
        this.workerModel = config.workerModel
        return this.buildHarness(config.mainModel)
      })
      .catch((error: unknown) => {
        this.harness = undefined
        throw error
      })
    return this.harness
  }

  private async buildHarness(mainModel: string): Promise<Harness> {
    await ensurePluginsLoaded()
    const servers = await loadUserMcpServers()
    // Browser, Chrome, Computer Use and site adapters all live in node_repl. Mounted with no
    // conversation id but with this process's key: each worker's call names the worker (tools.ts)
    // and gets its own context in the shared kernel (node-repl-bridge.ts). Gated like chats; the
    // route re-checks per call.
    const surfaces = workerSurfaces()
    if (surfaces.browser || surfaces.chrome || surfaces.computer) {
      servers.node_repl = {
        transport: 'http',
        url: withApiToken(`http://127.0.0.1:${process.env.OPERON_PORT ?? '3100'}/api/node-repl-mcp?${assistantNodeReplQuery()}`),
      }
    }
    const host = this.toolHost

    const mainAgent = defineAgent({
      name: 'assistant',
      instructions: (ctx) => this.mainInstructions(ctx.sessionId),
      tools: [
        profileEditTool(host),
        setIdentityTool(host),
        memorySearchTool,
        startTaskTool(host),
        continueTaskTool(host),
        stopTaskTool(host),
        listTasksTool(host),
        ...scheduleTools({
          list: () => this.schedules.list(),
          create: (input) => this.schedules.create(input),
          update: (id, patch) => this.schedules.update(id, patch),
          remove: (id) => this.schedules.remove(id),
        }),
      ],
    })

    // Workers act on their own; the `auto` judge decides what needs a human, and anything it
    // escalates becomes an approval card in the thread (or is skipped, unattended). Kept so each
    // worker session can open with the user's standing grants added as allow rules.
    const permission: PermissionManagerOptions = {
      mode: 'auto',
      rules: [],
      autoApprover: new LlmAutoApprover({
        rules: {},
        // Judge with the fast conversation model rather than each worker's own: it reviews nearly
        // every browser call, and its two-stage design only escalates to thinking on a block.
        // (Picked up at harness build; a changed conversation model reaches the judge on restart.)
        model: await resolveModel(mainModel),
        onOutcome: (r) => console.log(`[assistant] auto-approval ${r.outcome} for ${r.toolName} in ${r.durationMs}ms${r.reason ? `: ${r.reason}` : ''}`),
      }),
    }
    this.permissionBase = permission

    return createLocalHarness({
      model: mainModel,
      resolveModel,
      homeDir: ASSISTANT_HARNESS_HOME,
      workDir: ASSISTANT_WORKSPACE,
      loadDiskProfiles: false,
      agent: mainAgent,
      workflowTool: false,
      permission,
      // Worker sessions and the main agent's share a harness but not a tool palette.
      session: (ctx) => {
        const workerId = workerOfSession(ctx.sessionId)
        return [
          ...defaultCapabilities({
            ownEnvironment: ctx.ownEnvironment,
            pluginManager,
            sessionMcpServers: servers,
            oauthService: mcpOAuthService,
          }),
          workerId ? workerScopeCapability(workerId) : mainScopeCapability,
          // The main agent's sessions hear about the time and other people's file edits.
          ...(workerId || ctx.sessionId.startsWith(UTILITY_PREFIX) ? [] : [this.reminderCapability(ctx.sessionId)]),
        ]
      },
    })
  }

  // ---------------------------------------------------------------------------
  // The main agent's session: one at a time, renewed daily
  // ---------------------------------------------------------------------------

  private mainContext(sessionId: string): { instructions?: string; reminder: ContextReminder } {
    let context = this.mainContexts.get(sessionId)
    if (!context) {
      context = { reminder: new ContextReminder(() => listProfileFiles()) }
      this.mainContexts.set(sessionId, context)
    }
    return context
  }

  /** The main agent's system prompt: built at its session's first turn, then kept (prompt cache). */
  private mainInstructions(sessionId: string): string {
    const context = this.mainContext(sessionId)
    if (context.instructions === undefined) {
      const seed = this.storage.get<{ sessionId: string; text: string }>(SEED_KEY)
      context.instructions = buildMainInstructions(
        filesRecord(),
        this.storage.get<string>(LOCALE_KEY),
        seed?.sessionId === sessionId ? seed.text : undefined,
      )
      context.reminder.markAll()
    }
    return context.instructions
  }

  /**
   * A definition file changed. Who the assistant is (identity, soul) changes rarely and reshapes
   * everything, so the system prompt is rebuilt; memory.md and heartbeat.md change often and reach
   * the main agent as a turn reminder — unless it made the edit itself.
   */
  private onProfileChanged(name: ProfileFileName, byMainAgent: boolean): void {
    if (name === 'identity' || name === 'soul') {
      for (const context of this.mainContexts.values()) delete context.instructions
      return
    }
    if (byMainAgent && this.session) this.mainContext(this.session.id).reminder.mark(name)
  }

  private reminderCapability(sessionId: string): Capability {
    return {
      name: 'assistant-reminders',
      contract: 'detachable',
      injectors: [
        {
          id: 'assistant-context',
          inject: () => {
            const text = this.mainContext(sessionId).reminder.next()
            return text ? { text } : null
          },
        },
      ],
    }
  }

  private ensureSession(): Promise<HarnessSession> {
    if (this.session) return Promise.resolve(this.session)
    this.sessionPromise ??= this.openSession().catch((error: unknown) => {
      this.sessionPromise = undefined
      throw error
    })
    return this.sessionPromise
  }

  /**
   * The main agent's session for something that is about to reach it — a fresh one if the current
   * one has had its day and is not in the middle of a turn (then the next event rotates instead).
   * @param before the thread up to here is what the new session is told about; later messages
   *   (the one being delivered) reach it on their own.
   */
  private async mainSession(before = Date.now()): Promise<HarnessSession> {
    if (this.rotating) return this.rotating
    const session = await this.ensureSession()
    if (!rotationDue(this.storage.get<number>(STARTED_KEY), Date.now())) return session
    const status = session.status
    if (status.state === 'running' || status.hasQueuedMessages) return session
    this.rotating = this.rotate(session, before).finally(() => {
      this.rotating = undefined
    })
    return this.rotating
  }

  private async openSession(): Promise<HarnessSession> {
    const config = await this.effectiveConfig()
    if (config.blocker) throw new Error(config.blocker)
    const harness = await this.ensureHarness()

    const storedId = this.storage.get<string>(SESSION_KEY)
    // A session from before rotation existed has no start time: due now, like any day-old one.
    const startedAt = this.storage.get<number>(STARTED_KEY) ?? (storedId ? 0 : undefined)
    if (storedId && !rotationDue(startedAt, Date.now())) {
      try {
        const session = await harness.resumeSession(storedId)
        // Sessions from before workers had sessions of their own carry worker shards, and
        // operon-agents alpha.15 folds the whole log into main's context on resume (fixed in the
        // framework, unreleased). Dropping the cache makes the next turn replay main's shard alone.
        session.core.invalidateLiveContext('main')
        return this.attachMain(session, config.mainModel)
      } catch (error) {
        console.warn('[assistant] could not resume the session, starting a new one:', error)
      }
    }
    // Starting over (first use, a day-old session, or one that would not resume). The old one is
    // not reopened just to close it; its stretch of the thread still gets its wrap-up.
    const session = await this.createMainSession(harness, Date.now())
    if (storedId) void this.wrapUp(startedAt ?? 0, Date.now())
    return this.attachMain(session, config.mainModel)
  }

  private async createMainSession(harness: Harness, before: number): Promise<HarnessSession> {
    const recent = this.storage.assistantMessageList({ limit: 60, before })
    const seed = buildSessionSeed(recent, this.storage.assistantActivityList(10))
    const session = await harness.createSession({ workDir: ASSISTANT_WORKSPACE, title: 'Assistant' })
    if (seed) this.storage.set(SEED_KEY, { sessionId: session.id, text: seed })
    else this.storage.delete(SEED_KEY)
    this.storage.set(SESSION_KEY, session.id)
    this.storage.set(STARTED_KEY, Date.now())
    return session
  }

  private attachMain(session: HarnessSession, model: string): HarnessSession {
    session.setModel(model)
    this.detachMain = session.onEvent((event) => {
      try {
        this.projector.handle(event)
      } catch (error) {
        console.error('[assistant] failed to project event', event.type, error)
      }
    })
    this.session = session
    return session
  }

  /** Hand the conversation to a fresh session; the old one is closed and gets its wrap-up. */
  private async rotate(old: HarnessSession, before: number): Promise<HarnessSession> {
    const config = await this.effectiveConfig()
    const from = this.storage.get<number>(STARTED_KEY) ?? 0
    const harness = await this.ensureHarness()
    const next = await this.createMainSession(harness, before)
    this.detachMain?.()
    this.attachMain(next, config.mainModel)
    this.mainContexts.delete(old.id)
    console.log(`[assistant] rotated the main session ${old.id} → ${next.id}`)
    void old.close().catch((error: unknown) => console.warn('[assistant] closing the old main session failed:', error))
    void this.wrapUp(from, before)
    return next
  }

  /**
   * The safety net behind "save it as you go": read the stretch of the thread a finished session
   * covered and let the model fix up memory.md. Silent, in a throwaway session of its own.
   */
  private async wrapUp(from: number, to: number): Promise<void> {
    try {
      const messages = this.storage.assistantMessageList({ limit: 400, before: to }).filter((m) => m.createdAt >= from)
      if (!messages.some((m) => m.role === 'user')) return
      const activities = this.storage
        .assistantActivityList(100)
        .filter((a) => a.finishedAt !== undefined && a.finishedAt >= from && a.finishedAt < to)
      const config = await this.effectiveConfig()
      if (config.blocker) return
      const harness = await this.ensureHarness()
      // Its edits are someone else's as far as the main agent is concerned: they come as a reminder.
      const host: AssistantToolHost = {
        ...this.toolHost,
        onRemembered: () => undefined,
        onFileWritten: (name) => this.emit({ type: 'file', file: readProfileFile(name) }),
      }
      const id = `${UTILITY_PREFIX}${randomUUID()}`
      const session = await harness.createSession({
        id,
        title: 'Wrap-up',
        agent: defineAgent({ name: 'assistant-wrap-up', instructions: () => buildWrapUpInstructions(filesRecord()), tools: [profileEditTool(host)] }),
      })
      session.setModel(config.mainModel)
      session.setApprovalHandler(async () => ({ decision: 'rejected', feedback: 'Only memory.md can be changed here.' }))
      try {
        const before = readProfileFile('memory').content
        await session.prompt(
          `Here is the stretch of the conversation that just ended. Keep in memory.md whatever the days ahead need, then reply Done.\n\n<conversation>\n${buildWrapUpTranscript(messages, activities)}\n</conversation>`,
        )
        const changed = readProfileFile('memory').content !== before
        console.log(`[assistant] wrap-up of ${new Date(from).toISOString()}–${new Date(to).toISOString()}: memory.md ${changed ? 'updated' : 'unchanged'}`)
      } finally {
        await session.close().catch(() => undefined)
        await harness.deleteSession(id, { purge: true }).catch(() => undefined)
      }
    } catch (error) {
      console.warn('[assistant] wrap-up failed:', error)
    }
  }

  /** Something for the main agent that the user did not type: woken if idle, read next if busy. */
  private tellMain(text: string, origin: MainOrigin): void {
    void this.mainSession()
      .then((session) => {
        if (session.steerTo('main', text, origin)) return
        // A run left interrupted refuses steering; start a fresh turn instead.
        return session.prompt(text).then(() => undefined)
      })
      .catch((error: unknown) => console.warn('[assistant] could not reach the main agent:', error))
  }

  /** A worker's run ended: release its cards and tell the main agent what came of it. */
  private onWorkerSettled(outcome: WorkerOutcome): void {
    const { activity } = outcome
    this.approvals.expireFor(activity.id)
    forgetSessionComputerUseApprovals(approvalScope(activity.id))
    if (outcome.kind !== 'task') return
    const result = activity.report ?? outcome.finalText ?? ''
    const clipped = result.length > NOTICE_RESULT_LIMIT ? `${result.slice(0, NOTICE_RESULT_LIMIT)}\n… (truncated)` : result
    const lines = [
      `[Task finished] "${activity.title}" (id ${activity.id}) ${END_LABEL[outcome.end]} — status: ${activity.status}.`,
      `Summary: ${activity.summary}`,
      ...(outcome.error && activity.status === 'failed' ? [`Error: ${outcome.error}`] : []),
      ...(clipped && outcome.end !== 'stopped' ? ['Result:', clipped] : []),
    ]
    this.tellMain(lines.join('\n'), { kind: 'external', source: 'worker-done', metadata: { activityId: activity.id }, channel: 'follow_up' })
  }

  // ---------------------------------------------------------------------------
  // Heartbeat and scheduled tasks (the app's scheduler calls runSchedule)
  // ---------------------------------------------------------------------------

  /** One due run of the heartbeat or a scheduled task. Resolves when the run is over. */
  readonly runSchedule: AssistantCronRunner = async (job) => {
    const config = await this.effectiveConfig()
    if (config.blocker) return { status: 'error', error: config.blocker }
    await this.ensureHarness()
    return this.schedules.isHeartbeat(job.id) ? this.runHeartbeat(job, config) : this.runScheduled(job)
  }

  private told(): Array<{ at: number; text: string }> {
    const cutoff = Date.now() - TOLD_TTL_MS
    return (this.storage.get<Array<{ at: number; text: string }>>(HEARTBEAT_TOLD_KEY) ?? []).filter((t) => t.at >= cutoff)
  }

  /**
   * Look around for what the user would want to hear about, in a session of its own so 48 checks
   * a day never reach the main agent's context. Silent runs leave only a line in the run log.
   */
  private async runHeartbeat(job: CronjobTask, config: AssistantConfig): Promise<Awaited<ReturnType<AssistantCronRunner>>> {
    type Held = { at: number; text: string; urgent: boolean; activityId: string }
    const now = Date.now()
    const quiet = inQuietHours(new Date(now), config.quietStart, config.quietEnd)
    const held = this.storage.get<Held[]>(HEARTBEAT_HELD_KEY) ?? []
    const files = filesRecord()
    const connectors = await this.connectors()
    const logRun = (outcome: 'silent' | 'found' | 'failed', note?: string, activityId?: string) =>
      this.schedules.recordRun({ id: randomUUID(), scheduleId: job.id, at: now, outcome, ...(note ? { note } : {}), ...(activityId ? { activityId } : {}) })

    let found: Held[] = []
    if (!heartbeatHasWork(files.heartbeat.content, files.memory.content, connectors)) {
      logRun('silent', 'Nothing to check')
    } else {
      this.heartbeatConnectors = connectors
      const { id, done } = await this.workers.start({
        kind: 'heartbeat',
        title: 'Heartbeat',
        prompt: buildHeartbeatPrompt(job.lastRunAt, this.told(), held),
        unattended: true,
        visible: false,
      })
      const outcome = await done
      const args = outcome.finish?.tool === 'heartbeat_done' ? outcome.finish.args : undefined
      if (outcome.end !== 'completed' || outcome.error) {
        logRun('failed', outcome.error ?? outcome.activity.summary)
        return { status: 'error', error: outcome.error ?? outcome.activity.summary }
      }
      const findings = (Array.isArray(args?.findings) ? args.findings : [])
        .map((f) => record(f))
        .filter((f) => typeof f.text === 'string' && f.text.trim())
        .map((f) => ({ text: String(f.text).trim(), urgent: f.urgent === true }))
      const expired = Array.isArray(args?.remove_lines) ? args.remove_lines.filter((l): l is string => typeof l === 'string') : []
      if (expired.length) {
        const current = readProfileFile('heartbeat').content
        const next = removeLines(current, expired)
        if (next !== current) this.emit({ type: 'file', file: writeProfileFile('heartbeat', next, 'assistant') })
      }
      if (!findings.length) {
        logRun('silent')
        // Nothing worth keeping on disk either: the run log line is the whole record.
        void this.ensureHarness()
          .then((h) => h.deleteSession(outcome.activity.taskId, { purge: true }))
          .catch(() => undefined)
      } else {
        const activity = outcome.activity
        activity.title = summaryLine(findings[0]!.text).slice(0, 80) || 'Heartbeat'
        activity.summary = findings.map((f) => f.text).join(' · ')
        activity.report = findings.map((f) => `- ${f.urgent ? '(urgent) ' : ''}${f.text}`).join('\n')
        this.saveActivity(activity)
        found = findings.map((f) => ({ ...f, at: now, activityId: id }))
        logRun('found', findings[0]!.text, id)
      }
    }

    // Quiet hours: only the urgent goes out now; the rest waits for the first check after. The
    // check is shown what is held so it does not find it again, and a repeat is dropped anyway.
    const heldTexts = new Set(held.map((f) => f.text))
    const fresh = found.filter((f) => !heldTexts.has(f.text))
    const sayNow = quiet ? fresh.filter((f) => f.urgent) : [...held, ...fresh]
    const keep = quiet ? [...held, ...fresh.filter((f) => !f.urgent)] : []
    this.storage.set(HEARTBEAT_HELD_KEY, keep)
    if (sayNow.length) {
      this.storage.set(HEARTBEAT_TOLD_KEY, [...this.told(), ...sayNow.map((f) => ({ at: f.at, text: f.text }))].slice(-TOLD_KEPT))
      this.tellMain(
        [
          '[Heartbeat] Noticed in the background, worth telling the user now:',
          ...sayNow.map((f) => `- ${f.urgent ? '(urgent) ' : ''}${f.text}`),
        ].join('\n'),
        { kind: 'external', source: 'heartbeat', metadata: { activityId: sayNow.at(-1)!.activityId }, channel: 'follow_up' },
      )
    }
    return { status: 'success', output: found.length ? found.map((f) => f.text).join('\n') : 'Nothing new' }
  }

  /** A task the user set up to run at set times: a visible activity, its result relayed by the main agent. */
  private async runScheduled(job: CronjobTask): Promise<Awaited<ReturnType<AssistantCronRunner>>> {
    const cadence = cadenceOf(job.schedule)
    const { id, done } = await this.workers.start({
      kind: 'schedule',
      title: job.name,
      prompt: buildScheduledPrompt(job.name, cadence, job.prompt),
      unattended: true,
      visible: true,
    })
    const outcome = await done
    const { activity } = outcome
    const ok = activity.status === 'done' || activity.status === 'partial'
    this.schedules.recordRun({
      id: randomUUID(),
      scheduleId: job.id,
      at: activity.startedAt,
      outcome: ok ? 'found' : 'failed',
      note: activity.summary,
      activityId: id,
    })
    const result = activity.report ?? outcome.finalText ?? ''
    const clipped = result.length > NOTICE_RESULT_LIMIT ? `${result.slice(0, NOTICE_RESULT_LIMIT)}\n… (truncated)` : result
    this.tellMain(
      [
        `[Scheduled task "${job.name}" (${cadence.toLowerCase()})] ${END_LABEL[outcome.end]} — status: ${activity.status}.`,
        `Summary: ${activity.summary}`,
        ...(outcome.error && !ok ? [`Error: ${outcome.error}`] : []),
        ...(clipped && ok ? ['Result:', clipped] : []),
      ].join('\n'),
      { kind: 'external', source: 'schedule', metadata: { name: job.name, activityId: id }, channel: 'follow_up' },
    )
    return ok ? { status: 'success', output: activity.summary } : { status: 'error', error: outcome.error ?? activity.summary }
  }

  /** Pause, resume or delete from the Schedule tab. */
  setScheduleEnabled(id: number, enabled: boolean): boolean {
    if (!this.schedules.job(id)) return false
    this.schedules.update(id, { enabled })
    return true
  }

  deleteSchedule(id: number): boolean {
    return this.schedules.remove(id)
  }

  /** Take back an "Always allow". Workers already running keep it until they finish. */
  revokeGrant(id: string): boolean {
    return this.grants.remove(id)
  }

  hasSchedule(id: number): boolean {
    return this.schedules.job(id) !== undefined
  }

  /** A message from the assistant that did not come from the model (setup problems). */
  private sayFromHost(text: string): void {
    const message: AssistantMessage = { id: randomUUID(), role: 'assistant', text, createdAt: Date.now() }
    this.storage.assistantMessageUpsert(message)
    this.emit({ type: 'message', message })
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  /** @param uiLocale the app's interface language, remembered for the main agent's first words. */
  async state(uiLocale?: string): Promise<AssistantState> {
    if (uiLocale && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(uiLocale)) this.storage.set(LOCALE_KEY, uiLocale)
    const messages = this.storage.assistantMessageList({ limit: PAGE_SIZE })
    const config = await this.effectiveConfig()
    if (messages.length === 0 && !config.blocker) this.startOnboarding()
    return {
      messages,
      hasMore: messages.length === PAGE_SIZE,
      activities: this.storage.assistantActivityList(PAGE_SIZE),
      audit: this.storage.assistantAuditList(PAGE_SIZE),
      grants: this.grants.list(),
      files: listProfileFiles(),
      config: this.getConfig(),
      schedules: this.schedules.list(),
      typing: this.typing,
      ...(config.blocker ? { blocker: config.blocker } : {}),
    }
  }

  olderMessages(before: number): { messages: AssistantMessage[]; hasMore: boolean } {
    const messages = this.storage.assistantMessageList({ limit: PAGE_SIZE, before })
    return { messages, hasMore: messages.length === PAGE_SIZE }
  }

  /** First open, nobody named yet: the assistant speaks first. Once per process. */
  private startOnboarding(): void {
    if (this.onboardingKicked || parseIdentity(readProfileFile('identity').content).name) return
    this.onboardingKicked = true
    this.tellMain(ONBOARDING_KICK, { kind: 'external', source: 'onboarding', channel: 'follow_up' })
  }

  async send(text: string, attachments: AssistantAttachment[] = []): Promise<AssistantMessage> {
    const message: AssistantMessage = {
      id: randomUUID(),
      role: 'user',
      text,
      createdAt: Date.now(),
      ...(attachments.length ? { attachments } : {}),
    }
    this.storage.assistantMessageUpsert(message)
    this.emit({ type: 'message', message })

    let session: HarnessSession
    try {
      session = await this.mainSession(message.createdAt)
    } catch (error) {
      this.sayFromHost(error instanceof Error ? error.message : String(error))
      return message
    }
    const failed = (error: unknown) => this.sayFromHost(`Something went wrong on my side: ${String(error)}`)
    const input = buildUserInput(text, attachments)
    if (input.images.length) {
      // Steering carries text only, so images go in a turn of their own — after the current one
      // if the main agent is mid-turn (prompts on a session run one at a time).
      const content: (TextContent | ImageContent)[] = [...(input.text ? [{ type: 'text' as const, text: input.text }] : []), ...input.images]
      void session.prompt([{ role: 'user', content, timestamp: message.createdAt }]).catch(failed)
      return message
    }
    // Idle: queued and the main agent wakes for it. Mid-turn: it reads it at the next step.
    const receipt = session.steerTo('main', input.text, { kind: 'user' })
    if (!receipt) {
      // A run left interrupted refuses steering; start a fresh turn instead.
      void session.prompt(input.text).catch(failed)
    }
    return message
  }

  async stopActivity(id: string): Promise<boolean> {
    this.approvals.expireFor(id)
    return this.workers.stop(id)
  }

  /** The drawer's input: straight to the worker, running or finished — the thread is not involved. */
  async followUp(id: string, text: string): Promise<'delivered' | 'continued' | 'missing'> {
    if (!this.storage.assistantActivityGet(id)) return 'missing'
    try {
      await this.ensureHarness()
    } catch (error) {
      this.sayFromHost(error instanceof Error ? error.message : String(error))
      return 'missing'
    }
    return this.workers.continue(id, text, text)
  }

  writeFile(name: ProfileFileName, content: string): ProfileFile {
    const file = writeProfileFile(name, content, 'user')
    this.onProfileChanged(name, false)
    this.emit({ type: 'file', file })
    return file
  }
}

let instance: AssistantRuntime | undefined

export function getAssistantRuntime(storage: Storage): AssistantRuntime {
  instance ??= new AssistantRuntime(storage)
  return instance
}
