import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { mkdirSync } from 'fs'
import { LocalEnvironment, type McpServerConfig } from 'operon-agents'
import { loadMcpServers } from 'operon-agents/mcp'
import type { PermissionDecision } from '@operon/agent-runtime'
import type {
  Activity,
  AssistantAgentChoice,
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
import { getProviders } from '../ai/providers.js'
import { getBrowserUseConfig } from '../browser-use-config.js'
import { getChromeUseConfig } from '../chrome-use-config.js'
import { getComputerUseConfig } from '../computer-use-config.js'
import { listOperonModels } from '../operon-runtime/index.js'
import { pluginManager } from '../operon-runtime/plugins.js'
import { AgentChannel, isAssistantProvider, openRuntimeSession, PROVIDER_LABEL, type TurnInput } from './agents.js'
import { AssistantApprovals, type ApprovalAnswer } from './approvals.js'
import { buildUserInput } from './attachments.js'
import { ensureProfileFiles, listProfileFiles, parseIdentity, readProfileFile, watchProfileFiles, writeProfileFile } from './files.js'
import { bareToolName, isAssistantTool, stepLabel } from './labels.js'
import { setAssistantElicitationHandler, type AssistantRole } from './node-repl-bridge.js'
import { ASSISTANT_CONVERSATION_DIR, ASSISTANT_WORKSPACE, ASSISTANT_WRAPUP_DIR } from './paths.js'
import { AssistantProjector, record, summaryLine, type Cause } from './projector.js'
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
import { setAssistantToolHost, type AssistantToolHost } from './tools.js'
import { WorkerPool, type WorkerAgent, type WorkerKind, type WorkerOutcome, type WorkerSessionRef } from './workers.js'

type Storage = StorageAdapter & AssistantStorageAdapter & CronjobStorageAdapter

const CONFIG_KEY = 'assistant:config'
/** The main agent's current session: which agent, and its own session id once it has one. */
const SESSION_KEY = 'assistant:session'
/** Before sessions ran on any agent: an operon session id. Read once, to wrap that stretch up. */
const LEGACY_SESSION_KEY = 'assistant:session_id'
/** When the current main session started — it is renewed daily (rotation.ts). */
const STARTED_KEY = 'assistant:session_started_at'
/** What the current main session was told about the conversation before it. */
const SEED_KEY = 'assistant:session_seed'
/** The agent session each worker ran in, so a finished task can be continued. */
const WORKER_SESSIONS_KEY = 'assistant:worker_sessions'
const WORKER_SESSIONS_KEPT = 300
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
const MAIN_DENIED = 'You do not do tool work yourself. Hand it to a helper with start_task.'

/** The main agent's session as stored: which agent, and the agent's own id for it. */
interface StoredSession {
  /** Ours, per session: what the seed belongs to. */
  generation: string
  providerId: string
  modelId: string
  sessionId?: string
}

/** The main agent's live session. */
interface MainSession {
  generation: string
  agent: WorkerAgent
  channel: AgentChannel
  reminder: ContextReminder
}

/** Why the main session is to be replaced at the next chance. */
type RotationReason = 'day' | 'identity' | 'agent'

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

/** How a tool call reads on a card. */
function toolIcon(toolName: string): ApprovalIcon {
  const name = bareToolName(toolName).toLowerCase()
  if (/bash|shell|exec|command|terminal/.test(name)) return 'terminal'
  if (/write|edit|patch|file|read/.test(name)) return 'file'
  if (/fetch|web|browser|url/.test(name)) return 'globe'
  return 'tool'
}

/** Where a worker's "Allow once" on Computer Use is remembered: its own run, nobody else's. */
function approvalScope(workerId: string): string {
  return `assistant:${workerId}`
}

/** Longest worker result the main agent is handed in a notice; the drawer shows all of it. */
const NOTICE_RESULT_LIMIT = 6_000
const LISTED_TASKS = 10

const END_LABEL: Record<WorkerOutcome['end'], string> = {
  completed: 'finished',
  failed: 'failed',
  stopped: 'stopped by the user',
  timed_out: 'ran out of time and was stopped',
}

function sameChoice(a: AssistantAgentChoice | null | undefined, b: AssistantAgentChoice | null | undefined): boolean {
  return (a?.providerId ?? '') === (b?.providerId ?? '') && (a?.modelId ?? '') === (b?.modelId ?? '')
}

/**
 * The personal assistant: one long-lived session for the main agent (the one the user talks to),
 * plus a session per worker, folded into a single on-screen thread and an Activity list. Each runs
 * on the agent the user picked for it — operon, Codex, Claude Code or OpenCode — through the same
 * runtime the coding chats use. See docs/assistant/design.md.
 */
export class AssistantRuntime {
  private readonly bus = new EventEmitter()
  private readonly projector: AssistantProjector
  private readonly approvals: AssistantApprovals
  private readonly workers: WorkerPool
  private readonly schedules: AssistantSchedules
  private main: MainSession | undefined
  private mainOpening: Promise<MainSession> | undefined
  private rotating: Promise<MainSession> | undefined
  /** Set when the main session must be replaced before its day is over. */
  private rotationWanted: RotationReason | undefined
  /** Names for the heartbeat's instructions, read when its run starts. */
  private heartbeatConnectors: string[] = []
  private typing = false
  private onboardingKicked = false

  constructor(private readonly storage: Storage) {
    this.bus.setMaxListeners(50)
    ensureProfileFiles()
    for (const dir of [ASSISTANT_WORKSPACE, ASSISTANT_CONVERSATION_DIR, ASSISTANT_WRAPUP_DIR]) mkdirSync(dir, { recursive: true })

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
        agentFor: (kind) => this.agentFor(kind),
        instructions: (kind, unattended) => this.workerInstructions(kind, unattended),
        cwd: ASSISTANT_WORKSPACE,
        nodeRepl: () => {
          const s = workerSurfaces()
          return s.browser || s.chrome || s.computer
        },
        open: (params) => openRuntimeSession(params),
        activity: (activity) => this.saveActivity(activity),
        stored: (id) => storage.assistantActivityGet(id) ?? undefined,
        approve: (id, toolName, input) => this.onWorkerApproval(id, toolName, input),
        saveSession: (id, ref) => this.saveWorkerSession(id, ref),
        loadSession: (id) => this.workerSessions()[id],
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
    // The assistant's own tools, served over MCP to whichever agent runs a session.
    setAssistantToolHost(this.toolHost)

    watchProfileFiles((file) => {
      this.onProfileChanged(file.name, false)
      this.emit({ type: 'file', file })
    })

    this.schedules = new AssistantSchedules(storage, (schedules) => this.emit({ type: 'schedules', schedules }))
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

  // ---------------------------------------------------------------------------
  // Approvals: what each agent's own mode still leaves to a person (design.md §7)
  // ---------------------------------------------------------------------------

  private async onElicitation(workerId: string, request: HostElicitationRequest): Promise<HostElicitationResult> {
    // The Settings the chats share (block list, apps allowed for good there), then what the user
    // allowed for this task. That cache is per worker: shared by the whole assistant, one "Allow
    // once" would have held for every later worker until a restart, unattended runs included.
    const cached = cachedComputerUseApproval(approvalScope(workerId), request)
    if (cached) return cached
    const { title, icon, args } = describeElicitation(request)
    const entry = { title, detail: request.message, icon, activityId: workerId, ...(args ? { args } : {}) }
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
    if (answer !== 'allowed_once') return { action: 'cancel' }
    // "Allow once" covers this task: Computer Use asks before every action, so it is remembered
    // for this worker's run, as the kernel remembers a site for this worker's context.
    rememberComputerUseApproval(approvalScope(workerId), request, 'session')
    return { action: 'accept', _meta: { persist: 'session' } }
  }

  /** A worker's agent left a tool call to a person. */
  private async onWorkerApproval(activityId: string, toolName: string, input: unknown): Promise<PermissionDecision> {
    if (isAssistantTool(toolName)) return { type: 'allow' }
    const label = stepLabel(toolName, input, ASSISTANT_WORKSPACE)
    const detail = bareToolName(toolName)
    const icon = toolIcon(toolName)
    const args = record(input)
    if (this.workers.isUnattended(activityId)) {
      this.audit({ id: randomUUID(), title: label, detail: `Skipped while running unattended: ${detail}`, icon, decision: 'denied', at: Date.now(), activityId })
      return { type: 'deny', reason: "This step needs the user's approval and nobody is watching this run. Skip it and say in your result what you could not do and why." }
    }
    const answer = await this.approvals.request({ title: label, detail, icon, activityId, ...(Object.keys(args).length ? { args } : {}) })
    if (answer === 'allowed_once') return { type: 'allow' }
    if (answer === 'denied') return { type: 'deny', reason: 'The user declined this step.' }
    return { type: 'deny', reason: 'Nobody answered; the task was stopped.' }
  }

  /** The user answered an approval card. */
  answerApproval(id: string, decision: Exclude<ApprovalAnswer, 'expired' | 'always_allowed'>): boolean {
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
  // Config: which agent runs each part (Settings → Assistant)
  // ---------------------------------------------------------------------------

  getConfig(): AssistantConfig {
    type Legacy = { mainModel?: string; workerModel?: string }
    const stored = this.storage.get<Partial<AssistantConfig> & Legacy>(CONFIG_KEY) ?? {}
    // Before any agent could be picked, both ran on operon with a `provider/model` id.
    const choice = (value: AssistantAgentChoice | undefined, legacy: string | undefined): AssistantAgentChoice =>
      value && typeof value.providerId === 'string' ? { providerId: value.providerId, modelId: value.modelId ?? '' } : { providerId: 'custom', modelId: legacy ?? '' }
    return {
      main: choice(stored.main, stored.mainModel),
      worker: choice(stored.worker, stored.workerModel),
      background: stored.background && typeof stored.background.providerId === 'string' ? { providerId: stored.background.providerId, modelId: stored.background.modelId ?? '' } : null,
      quietStart: stored.quietStart ?? QUIET_DEFAULT.quietStart,
      quietEnd: stored.quietEnd ?? QUIET_DEFAULT.quietEnd,
    }
  }

  /**
   * The agent and model behind a choice, ready to run — or why not. An empty operon model falls
   * back to the first one set up; an empty model on the other agents is their own default.
   */
  private async resolveChoice(choice: AssistantAgentChoice): Promise<WorkerAgent | { blocker: string }> {
    const { providerId } = choice
    if (!isAssistantProvider(providerId)) return { blocker: `The assistant can't run on "${providerId}". Pick Operon, Claude Code, Codex or OpenCode in Settings → Assistant.` }
    const known = getProviders().find((p) => p.id === providerId)
    if (known && known.available === false) {
      return { blocker: `${PROVIDER_LABEL[providerId]} is not installed on this computer. Install it, or pick another agent in Settings → Assistant.` }
    }
    if (providerId !== 'custom' || choice.modelId) return { providerId, modelId: choice.modelId }
    const models = await listOperonModels().catch(() => [])
    const fallback = models[0]?.id
    return fallback ? { providerId, modelId: fallback } : { blocker: NO_MODEL }
  }

  /** The agent a kind of session runs on. Throws (with a message for the user) when none can. */
  private async agentFor(kind: WorkerKind | 'main'): Promise<WorkerAgent> {
    const config = this.getConfig()
    const choice = kind === 'main' ? config.main : kind === 'task' ? config.worker : (config.background ?? config.worker)
    const resolved = await this.resolveChoice(choice)
    if ('blocker' in resolved) throw new Error(resolved.blocker)
    return resolved
  }

  /** Why the assistant cannot run at all right now, if it cannot. */
  private async blocker(): Promise<string | undefined> {
    const config = this.getConfig()
    for (const choice of [config.main, config.worker]) {
      const resolved = await this.resolveChoice(choice)
      if ('blocker' in resolved) return resolved.blocker
    }
    return undefined
  }

  setConfig(patch: Partial<AssistantConfig>): AssistantConfig {
    const before = this.getConfig()
    const next = { ...before, ...patch }
    this.storage.set(CONFIG_KEY, next)
    // A different agent for the main agent means a different session: it takes over at the next
    // message, told how the conversation stood (§3). Workers pick it up when they next start.
    if (!sameChoice(before.main, next.main)) this.rotationWanted = 'agent'
    this.emit({ type: 'config', config: next })
    return next
  }

  // ---------------------------------------------------------------------------
  // The assistant's own tools (served over MCP, routes/assistant-mcp.ts)
  // ---------------------------------------------------------------------------

  private readonly toolHost: AssistantToolHost = {
    startTask: async ({ title, prompt }) => {
      const { id } = await this.workers.start({ kind: 'task', title, prompt, unattended: false, visible: true, asked: this.latestUserText() })
      this.projector.dispatch(id)
      return id
    },
    // The main agent's message is its own rewording; the user's words are what it acts on.
    continueTask: (id, message) => this.workers.continue(id, message, this.latestUserText()),
    stopTask: (id) => this.stopActivity(id),
    listTasks: () =>
      this.storage
        .assistantActivityList(LISTED_TASKS)
        .map((a) => ({ id: a.id, title: a.title, status: a.status, summary: a.summary })),
    progress: (activityId, text) => {
      if (!this.workers.progress(activityId, text) || this.workers.isUnattended(activityId)) return
      void this.toMain({ text: `[Progress from task ${activityId}] ${text}`, cause: { kind: 'progress', activityId } })
    },
    finish: (activityId, args) => this.workers.finish(activityId, args),
    heartbeatDone: (activityId, args) => this.workers.heartbeatDone(activityId, args),
    onRemembered: (line) => this.projector.remember(line),
    onFileWritten: (name, role) => this.onFileWritten(name, role),
    schedules: {
      list: () => this.schedules.list(),
      create: (input) => this.schedules.create(input),
      update: (id, patch) => this.schedules.update(id, patch),
      remove: (id) => this.schedules.remove(id),
    },
  }

  private onFileWritten(name: ProfileFileName, role: AssistantRole): void {
    // The main agent's own edits are not echoed back to it; anyone else's (the wrap-up) are.
    if (role === 'main') this.onProfileChanged(name, true)
    this.emit({ type: 'file', file: readProfileFile(name) })
  }

  /** Services the heartbeat can look at: the user's MCP servers and the plugins' (node_repl is a tool, not a service). */
  private async connectors(): Promise<string[]> {
    const names = new Set([...Object.keys(await loadUserMcpServers()), ...Object.keys(pluginManager.mcpServerConfigs())])
    names.delete('node_repl')
    return [...names].sort()
  }

  private workerInstructions(kind: WorkerKind, unattended: boolean): string {
    if (kind === 'heartbeat') return buildHeartbeatInstructions(filesRecord(), this.heartbeatConnectors)
    return buildWorkerInstructions(filesRecord(), { surfaces: workerSurfaces(), unattended })
  }

  private workerSessions(): Record<string, WorkerSessionRef> {
    return this.storage.get<Record<string, WorkerSessionRef>>(WORKER_SESSIONS_KEY) ?? {}
  }

  private saveWorkerSession(activityId: string, ref: WorkerSessionRef): void {
    const all = { ...this.workerSessions(), [activityId]: ref }
    const ids = Object.keys(all)
    for (const id of ids.slice(0, Math.max(0, ids.length - WORKER_SESSIONS_KEPT))) delete all[id]
    this.storage.set(WORKER_SESSIONS_KEY, all)
  }

  private forgetWorkerSession(activityId: string): void {
    const all = this.workerSessions()
    if (!(activityId in all)) return
    delete all[activityId]
    this.storage.set(WORKER_SESSIONS_KEY, all)
  }

  // ---------------------------------------------------------------------------
  // The main agent's session: one at a time, renewed daily
  // ---------------------------------------------------------------------------

  /**
   * A definition file changed. Who the assistant is (identity, soul) changes rarely and reshapes
   * everything, so the session is renewed at the next chance; memory.md and heartbeat.md change
   * often and reach the main agent as a note ahead of its next input — unless it made the edit.
   */
  private onProfileChanged(name: ProfileFileName, byMainAgent: boolean): void {
    if (name === 'identity' || name === 'soul') {
      this.rotationWanted ??= 'identity'
      return
    }
    if (byMainAgent) this.main?.reminder.mark(name)
  }

  private ensureMain(): Promise<MainSession> {
    if (this.main) return Promise.resolve(this.main)
    this.mainOpening ??= this.openMain()
      .then((main) => {
        this.main = main
        return main
      })
      .finally(() => {
        this.mainOpening = undefined
      })
    return this.mainOpening
  }

  private storedSession(): StoredSession | undefined {
    const stored = this.storage.get<StoredSession>(SESSION_KEY)
    return stored && typeof stored.providerId === 'string' && typeof stored.generation === 'string' ? stored : undefined
  }

  /**
   * The main agent's session for something about to reach it — a fresh one if the current one has
   * had its day (or its agent or identity changed) and is not in the middle of a turn; then the
   * next input renews it instead.
   * @param before the thread up to here is what a new session is told about; later messages
   *   (the one being delivered) reach it on their own.
   */
  private async mainSession(before = Date.now()): Promise<MainSession> {
    if (this.rotating) return this.rotating
    const main = await this.ensureMain()
    const reason: RotationReason | undefined =
      this.rotationWanted ?? (rotationDue(this.storage.get<number>(STARTED_KEY), Date.now()) ? 'day' : undefined)
    if (!reason || main.channel.busy) return main
    this.rotating = this.rotate(main, before, reason).finally(() => {
      this.rotating = undefined
    })
    return this.rotating
  }

  private async openMain(): Promise<MainSession> {
    // Whatever asked for a renewal before there was a session is answered by opening one now.
    this.rotationWanted = undefined
    const agent = await this.agentFor('main')
    const stored = this.storedSession()
    const startedAt = this.storage.get<number>(STARTED_KEY)
    // Resume when the session is today's, on the agent still configured, and the agent gave it an id.
    if (stored?.sessionId && stored.providerId === agent.providerId && stored.modelId === agent.modelId && !rotationDue(startedAt, Date.now())) {
      try {
        return await this.startMain(agent, { generation: stored.generation, sessionId: stored.sessionId })
      } catch (error) {
        console.warn('[assistant] could not resume the main session, starting a new one:', error)
      }
    }
    // Starting over (first use, a day-old session, a new agent, or one that would not resume).
    // The old stretch of the thread still gets its wrap-up.
    const hadOne = stored !== undefined || this.storage.get<string>(LEGACY_SESSION_KEY) !== undefined
    this.storage.delete(LEGACY_SESSION_KEY)
    const main = await this.startMain(agent, { before: Date.now() })
    if (hadOne) void this.wrapUp(startedAt ?? 0, Date.now())
    return main
  }

  /**
   * Open the main agent's session: resumed (`sessionId`) or new, told the conversation so far
   * (`before`: the thread up to there seeds it).
   */
  private async startMain(agent: WorkerAgent, from: { generation: string; sessionId: string } | { before: number }): Promise<MainSession> {
    const resumed = 'sessionId' in from
    const generation = resumed ? from.generation : randomUUID()
    let seed: string | undefined
    if (resumed) {
      const stored = this.storage.get<{ generation: string; text: string }>(SEED_KEY)
      seed = stored?.generation === generation ? stored.text : undefined
    } else {
      const recent = this.storage.assistantMessageList({ limit: 60, before: from.before })
      seed = buildSessionSeed(recent, this.storage.assistantActivityList(10)) || undefined
    }
    const reminder = new ContextReminder(() => listProfileFiles())
    const session = await openRuntimeSession({
      providerId: agent.providerId as WorkerAgent['providerId'],
      modelId: agent.modelId,
      kind: 'main',
      caller: { role: 'main' },
      cwd: ASSISTANT_CONVERSATION_DIR,
      instructions: buildMainInstructions(filesRecord(), this.storage.get<string>(LOCALE_KEY), seed),
      ...(resumed ? { sessionId: from.sessionId } : {}),
    })
    reminder.markAll()
    const record: StoredSession = { generation, providerId: agent.providerId, modelId: agent.modelId, ...(resumed ? { sessionId: from.sessionId } : {}) }
    this.storage.set(SESSION_KEY, record)
    if (!resumed) {
      if (seed) this.storage.set(SEED_KEY, { generation, text: seed })
      else this.storage.delete(SEED_KEY)
      this.storage.set(STARTED_KEY, Date.now())
    }
    const channel = new AgentChannel(session, {
      onTurnStart: (input) => this.projector.begin(input?.tag as Cause | undefined),
      onPart: (part) => {
        try {
          this.projector.part(part)
        } catch (error) {
          console.error('[assistant] failed to project a part', part.type, error)
        }
      },
      onTurnEnd: (end) => this.projector.end(end),
      onApproval: async (toolName) => (isAssistantTool(toolName) ? { type: 'allow' } : { type: 'deny', reason: MAIN_DENIED }),
      onSessionId: (sessionId) => {
        const current = this.storedSession()
        if (current?.generation === generation && current.sessionId !== sessionId) this.storage.set(SESSION_KEY, { ...current, sessionId })
      },
    })
    return { generation, agent, channel, reminder }
  }

  /** Hand the conversation to a fresh session; the old one is closed and its stretch wrapped up. */
  private async rotate(old: MainSession, before: number, reason: RotationReason): Promise<MainSession> {
    const from = this.storage.get<number>(STARTED_KEY) ?? 0
    const agent = await this.agentFor('main')
    const next = await this.startMain(agent, { before })
    this.main = next
    this.rotationWanted = undefined
    console.log(`[assistant] renewed the main session (${reason}) on ${agent.providerId}${agent.modelId ? `/${agent.modelId}` : ''}`)
    void old.channel.dispose()
    // Only a finished day is wrapped up; a new agent or identity mid-day carries the seed instead.
    if (reason === 'day') void this.wrapUp(from, before)
    return next
  }

  /**
   * The safety net behind "save it as you go": read the stretch of the thread a finished session
   * covered and let the model fix up memory.md. Silent, in a throwaway session of its own, on the
   * main agent's agent.
   */
  private async wrapUp(from: number, to: number): Promise<void> {
    try {
      const messages = this.storage.assistantMessageList({ limit: 400, before: to }).filter((m) => m.createdAt >= from)
      if (!messages.some((m) => m.role === 'user')) return
      const activities = this.storage
        .assistantActivityList(100)
        .filter((a) => a.finishedAt !== undefined && a.finishedAt >= from && a.finishedAt < to)
      const agent = await this.agentFor('main')
      const id = randomUUID()
      const session = await openRuntimeSession({
        providerId: agent.providerId,
        modelId: agent.modelId,
        kind: 'unattended',
        caller: { role: 'wrapup', id },
        cwd: ASSISTANT_WRAPUP_DIR,
        instructions: buildWrapUpInstructions(filesRecord()),
      })
      const channel = new AgentChannel(session, {
        onApproval: async (toolName) => (isAssistantTool(toolName) ? { type: 'allow' } : { type: 'deny', reason: 'Only memory.md can be changed here.' }),
      })
      try {
        const before = readProfileFile('memory').content
        await channel.deliver({
          text: `Here is the stretch of the conversation that just ended. Keep in memory.md whatever the days ahead need, then reply Done.\n\n<conversation>\n${buildWrapUpTranscript(messages, activities)}\n</conversation>`,
        })
        await channel.whenIdle()
        const changed = readProfileFile('memory').content !== before
        console.log(`[assistant] wrap-up of ${new Date(from).toISOString()}–${new Date(to).toISOString()}: memory.md ${changed ? 'updated' : 'unchanged'}`)
      } finally {
        await channel.dispose()
      }
    } catch (error) {
      console.warn('[assistant] wrap-up failed:', error)
    }
  }

  /**
   * Everything that reaches the main agent goes through here: the user, a finished worker, the
   * heartbeat, a scheduled run. Idle, it starts a turn; mid-turn it is folded in (or waits for the
   * next turn), and the thread is told why the agent is speaking either way. Anything the agent's
   * instructions no longer say — the time, files someone else changed — rides in front.
   */
  private async toMain(input: TurnInput & { cause: Cause }, before?: number): Promise<void> {
    const main = await this.mainSession(before)
    const note = main.reminder.next()
    const text = note ? `<context>\n${note}\n</context>\n\n${input.text}` : input.text
    const how = await main.channel.deliver({ ...input, text, tag: input.cause })
    if (how === 'injected') this.projector.setCause(input.cause)
  }

  /** Something for the main agent that the user did not type; failures only reach the log. */
  private tellMain(text: string, cause: Cause): void {
    void this.toMain({ text, cause }).catch((error: unknown) => console.warn('[assistant] could not reach the main agent:', error))
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
    this.tellMain(lines.join('\n'), { kind: 'worker', activityId: activity.id })
  }

  // ---------------------------------------------------------------------------
  // Heartbeat and scheduled tasks (the app's scheduler calls runSchedule)
  // ---------------------------------------------------------------------------

  /** One due run of the heartbeat or a scheduled task. Resolves when the run is over. */
  readonly runSchedule: AssistantCronRunner = async (job) => {
    const blocker = await this.blocker()
    if (blocker) return { status: 'error', error: blocker }
    return this.schedules.isHeartbeat(job.id) ? this.runHeartbeat(job) : this.runScheduled(job)
  }

  private told(): Array<{ at: number; text: string }> {
    const cutoff = Date.now() - TOLD_TTL_MS
    return (this.storage.get<Array<{ at: number; text: string }>>(HEARTBEAT_TOLD_KEY) ?? []).filter((t) => t.at >= cutoff)
  }

  /**
   * Look around for what the user would want to hear about, in a session of its own so 48 checks
   * a day never reach the main agent's context. Silent runs leave only a line in the run log.
   */
  private async runHeartbeat(job: CronjobTask): Promise<Awaited<ReturnType<AssistantCronRunner>>> {
    type Held = { at: number; text: string; urgent: boolean; activityId: string }
    const config = this.getConfig()
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
        .filter((f) => typeof f.text === 'string' && f.text.trim())
        .map((f) => ({ text: f.text.trim(), urgent: f.urgent === true }))
      const expired = Array.isArray(args?.remove_lines) ? args.remove_lines.filter((l): l is string => typeof l === 'string') : []
      if (expired.length) {
        const current = readProfileFile('heartbeat').content
        const next = removeLines(current, expired)
        if (next !== current) this.emit({ type: 'file', file: writeProfileFile('heartbeat', next, 'assistant') })
      }
      if (!findings.length) {
        logRun('silent')
        // Nothing worth continuing: the run log line is the whole record.
        this.forgetWorkerSession(id)
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
        { kind: 'heartbeat', activityId: sayNow.at(-1)!.activityId },
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
      { kind: 'schedule', name: job.name, activityId: id },
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
    const blocker = await this.blocker()
    if (messages.length === 0 && !blocker) this.startOnboarding()
    return {
      messages,
      hasMore: messages.length === PAGE_SIZE,
      activities: this.storage.assistantActivityList(PAGE_SIZE),
      audit: this.storage.assistantAuditList(PAGE_SIZE),
      files: listProfileFiles(),
      config: this.getConfig(),
      schedules: this.schedules.list(),
      typing: this.typing,
      ...(blocker ? { blocker } : {}),
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
    this.tellMain(ONBOARDING_KICK, { kind: 'system' })
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
    const input = buildUserInput(text, attachments)
    try {
      await this.toMain({ text: input.text, images: input.images, cause: { kind: 'user' } }, message.createdAt)
    } catch (error) {
      this.sayFromHost(error instanceof Error ? error.message : String(error))
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
      return await this.workers.continue(id, text, text)
    } catch (error) {
      this.sayFromHost(error instanceof Error ? error.message : String(error))
      return 'missing'
    }
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
