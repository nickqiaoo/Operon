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
import type { ApprovalIcon, AssistantSchedule, AuditRecord, ScheduleRunOutcome } from '../../../../shared/assistant.js'
import { heartbeatTold, INTERRUPTED_SUMMARY, NOTHING_TO_CHECK_NOTE, UNATTENDED_SKIP_PREFIX, withHeartbeatTold } from '../../../../shared/assistant.js'
import type { AssistantBlockerReason } from '../../../../shared/assistant.js'
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
import { ensurePluginsLoaded, pluginManager } from '../operon-runtime/plugins.js'
import { onMcpAuthChanged } from '../operon-runtime/mcp-oauth.js'
import { checkPluginSignIns, listPluginMcpMounts, pluginMcpNeedingSignIn } from '../operon-runtime/plugin-mcp.js'
import {
  AgentChannel,
  isAssistantProvider,
  openRuntimeSession,
  PROVIDER_LABEL,
  workerServiceServers,
  type AssistantProviderId,
  type TurnInput,
} from './agents.js'
import { AssistantApprovals, type ApprovalAnswer } from './approvals.js'
import { buildUserInput } from './attachments.js'
import { addedFacts, ensureProfileFiles, listProfileFiles, parseIdentity, peekProfileFile, readProfileFile, watchProfileFiles, writeProfileFile } from './files.js'
import { bareToolName, isAssistantTool, stepLabel } from './labels.js'
import { setAssistantElicitationHandler, type AssistantRole } from './node-repl-bridge.js'
import { ASSISTANT_DIR, ASSISTANT_WORKSPACE, ASSISTANT_WRAPUP_DIR, DAYS_DIR } from './paths.js'
import { AssistantProjector, record, summaryLine, type Cause } from './projector.js'
import {
  buildHeartbeatInstructions,
  buildHeartbeatPrompt,
  buildMainInstructions,
  MAIN_PROMPT_REVISION,
  buildScheduledPrompt,
  buildWorkerInstructions,
  buildWrapUpInstructions,
  type WorkerSurfaces,
} from './prompts.js'
import { buildSessionSeed, buildWrapUpTranscript, ContextReminder, rotationDue } from './rotation.js'
import { AssistantSchedules, cadenceOf, heartbeatHasWork, inQuietHours } from './schedule.js'
import { createOperonState, type OperonState, type OperonStateStorage } from './operon-state.js'
import { CodingAgents } from './coding.js'
import { createOperonActions, type OperonActions, type OperonActionsStorage } from './operon-actions.js'
import {
  createExternalAgent,
  externalAgentView,
  getExternalAgentStatus,
  sendExternalAgent,
  setAssistantAgentResultSink,
  stopExternalAgent,
  subscribeExternalAgents,
} from '../external-agent.js'
import { subscribePendingInput } from '../ai/chat-pending-input.js'
import { agentModelCatalog } from '../agents/model-catalog.js'
import { getDiffStat } from '../git.js'
import { SUPPORTED_EXTERNAL_AGENT_IDS } from '../../routes/external-agent-mcp.js'
import { setAssistantToolHost, type AssistantToolHost } from './tools.js'
import { WorkerPool, type InFlightRun, type WorkerAgent, type WorkerKind, type WorkerOutcome, type WorkerSessionRef } from './workers.js'

type Storage = StorageAdapter & AssistantStorageAdapter & CronjobStorageAdapter & OperonStateStorage & OperonActionsStorage

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
/** Worker runs in progress (InFlightRun); what is left here at startup was cut off by the restart. */
const WORKER_RUNS_KEY = 'assistant:worker_runs'
const WORKER_SESSIONS_KEPT = 300
const LOCALE_KEY = 'assistant:ui_locale'
/**
 * Left by older builds: what the heartbeat had told the user and what it held for quiet hours (now
 * its own "Already told" section of heartbeat.md), and the services it had marked "can't check"
 * (now heartbeat.md says what to check).
 */
const OLD_HEARTBEAT_KEYS = ['assistant:heartbeat_told', 'assistant:heartbeat_held', 'assistant:heartbeat_limits']
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
  /** `MAIN_PROMPT_REVISION` when it was opened; a different one means its instructions are stale. */
  promptRevision?: string
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
  /** Coding agents it started in the user's workspaces. */
  private readonly coding: CodingAgents
  private main: MainSession | undefined
  private mainOpening: Promise<MainSession> | undefined
  /** Wrap-ups under way: their edits to the assistant's files are the assistant's. */
  private wrapUps = 0
  private rotating: Promise<MainSession> | undefined
  /** Set when the main session must be replaced before its day is over. */
  private rotationWanted: RotationReason | undefined
  /** Names for the heartbeat's instructions, read when its run starts. */
  private heartbeatConnectors: string[] = []
  private typing = false
  private onboardingKicked = false
  /** Tasks the last run of the app cut off, to carry on (resumeInterrupted). */
  private interrupted: Array<[string, InFlightRun]> = []

  constructor(private readonly storage: Storage) {
    this.bus.setMaxListeners(50)
    ensureProfileFiles()
    for (const dir of [ASSISTANT_WORKSPACE, ASSISTANT_WRAPUP_DIR, DAYS_DIR]) mkdirSync(dir, { recursive: true })

    // Workers live inside this process; whatever was running when it last stopped is gone. The
    // tasks the user asked for are carried on (resumeInterrupted); a heartbeat or scheduled run
    // just waits for its next turn.
    const cut = storage.get<Record<string, InFlightRun>>(WORKER_RUNS_KEY) ?? {}
    this.interrupted = Object.entries(cut).filter(([, run]) => run.kind === 'task' && !run.unattended)
    storage.set(WORKER_RUNS_KEY, {})
    for (const a of storage.assistantActivityList(PAGE_SIZE)) {
      if (a.status !== 'running' && a.status !== 'waiting') continue
      storage.assistantActivityUpsert({
        ...a,
        status: 'stopped',
        summary: INTERRUPTED_SUMMARY,
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
        activity: (activity) => this.saveActivity(activity),
      },
      () => randomUUID(),
    )

    this.workers = new WorkerPool(
      {
        agentFor: (kind) => this.agentFor(kind),
        instructions: (kind, unattended) => this.workerInstructions(kind, unattended),
        cwd: ASSISTANT_WORKSPACE,
        // Day notes only: a worker writes what it observes there; memory.md is the main agent's to
        // curate (the sandbox enforces it on Codex and Claude).
        writableDirs: [DAYS_DIR],
        nodeRepl: () => {
          const s = workerSurfaces()
          return s.browser || s.chrome || s.computer
        },
        open: (params) => openRuntimeSession(params),
        activity: (activity) => this.saveActivity(activity),
        // Only a worker's own activities have a worker task behind them to pick back up: not the
        // main agent's turns, not a coding agent's conversation.
        stored: (id) => {
          const activity = storage.assistantActivityGet(id)
          return activity && !activity.agent ? activity : undefined
        },
        approve: (id, toolName, input) => this.onWorkerApproval(id, toolName, input),
        saveSession: (id, ref) => this.saveWorkerSession(id, ref),
        loadSession: (id) => this.workerSessions()[id],
        saveRun: (id, run) => this.storage.set(WORKER_RUNS_KEY, { ...this.storage.get<Record<string, InFlightRun>>(WORKER_RUNS_KEY), [id]: run }),
        clearRun: (id) => {
          const runs = { ...this.storage.get<Record<string, InFlightRun>>(WORKER_RUNS_KEY) }
          delete runs[id]
          this.storage.set(WORKER_RUNS_KEY, runs)
        },
        settled: (outcome) => this.onWorkerSettled(outcome),
      },
      () => randomUUID(),
    )

    this.coding = new CodingAgents(
      {
        workspace: (id) => {
          const workspace = storage.getWorkspace(id)
          if (!workspace) return undefined
          return { workspace, project: storage.getProject(workspace.projectId) ?? undefined }
        },
        create: async (input) => {
          const started = await createExternalAgent({
            parent: { assistantActivityId: input.activityId, workspaceId: input.workspaceId },
            providerId: input.providerId,
            model: input.model,
            effort: input.effort,
            description: input.title,
            prompt: input.prompt,
          })
          return { chatId: started.chat_id }
        },
        activityOf: (chatId) => externalAgentView(chatId)?.assistantActivityId,
        send: (chatId, prompt) => void sendExternalAgent('assistant', `ext-${chatId}`, prompt),
        stop: (chatId) => stopExternalAgent('assistant', `ext-${chatId}`).stopped,
        status: (chatId) => getExternalAgentStatus('assistant', `ext-${chatId}`),
        diffStat: async (path) => {
          const { staged, unstaged } = await getDiffStat(path)
          return { ...staged, ...unstaged }
        },
        activity: (id) => storage.assistantActivityGet(id) ?? undefined,
        save: (activity) => this.saveActivity(activity),
        // An empty message carrying the activity: the thread renders it as the conversation's card.
        card: (activityId) => {
          const message: AssistantMessage = { id: randomUUID(), role: 'assistant', text: '', createdAt: Date.now(), activityId }
          storage.assistantMessageUpsert(message)
          this.emit({ type: 'message', message })
        },
        tell: (text, cause) => this.tellMain(text, cause),
        now: () => Date.now(),
      },
      () => randomUUID(),
    )
    setAssistantAgentResultSink(({ view, event, dispatched, final, result }) => {
      void this.coding
        .turnEnded({ chatId: view.childChatId, status: event.status, ...(event.error ? { error: event.error } : {}), dispatched, result: final || result })
        .catch((error: unknown) => console.warn('[assistant] coding agent result:', error))
    })
    subscribeExternalAgents((frame) => {
      if (frame.type === 'updated' && frame.agent.assistantActivityId && frame.agent.status === 'running') {
        this.coding.turnStarted(frame.agent.childChatId)
      }
    })
    subscribePendingInput((change) =>
      this.coding.pendingChanged(change.chatId, change.pending, change.reason === 'requested' && change.first),
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

    // The agents edit these files with their own tools; a change while one of them is at work is
    // taken as theirs, any other as the user's (an editor, the app's own panel goes through writeFile).
    watchProfileFiles(
      (file) => {
        this.onProfileChanged(file.name, false)
        this.emit({ type: 'file', file })
      },
      () => (this.main?.channel.busy || this.workers.anyRunning || this.wrapUps > 0 ? 'assistant' : 'user'),
    )

    for (const key of OLD_HEARTBEAT_KEYS) storage.delete(key)
    this.schedules = new AssistantSchedules(storage, (schedules) => this.emit({ type: 'schedules', schedules: this.withSignInState(schedules) }))
    // The heartbeat starts with the assistant's first use, and is always on from then on.
    this.schedules.ensureHeartbeat()
    // Connecting (or disconnecting) a plugin changes what the heartbeat card says right away.
    const pushSchedules = () => this.emit({ type: 'schedules', schedules: this.withSignInState(this.schedules.list()) })
    onMcpAuthChanged(pushSchedules)
    // Which plugins are signed in is only known once the plugin store has loaded, and whether a
    // stored grant still works only once something has tried it.
    void ensurePluginsLoaded()
      .then(() => {
        pushSchedules()
        return checkPluginSignIns()
      })
      .then(pushSchedules, (error: unknown) => console.error('[assistant] plugin load failed:', error))
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
      this.audit({ id: randomUUID(), ...entry, detail: `${UNATTENDED_SKIP_PREFIX}${request.message}`, decision: 'denied', at: Date.now() })
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
      this.audit({ id: randomUUID(), title: label, detail: `${UNATTENDED_SKIP_PREFIX}${detail}`, icon, decision: 'denied', at: Date.now(), activityId })
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
  private async resolveChoice(choice: AssistantAgentChoice): Promise<WorkerAgent | { blocker: string; reason: AssistantBlockerReason }> {
    const { providerId } = choice
    if (!isAssistantProvider(providerId)) {
      return {
        blocker: `The assistant can't run on "${providerId}". Pick Operon, Claude Code, Codex or OpenCode in Settings → Assistant.`,
        reason: { kind: 'unknown-agent', agent: providerId },
      }
    }
    const known = getProviders().find((p) => p.id === providerId)
    if (known && known.available === false) {
      return {
        blocker: `${PROVIDER_LABEL[providerId]} is not installed on this computer. Install it, or pick another agent in Settings → Assistant.`,
        reason: { kind: 'not-installed', agent: PROVIDER_LABEL[providerId] },
      }
    }
    if (providerId !== 'custom' || choice.modelId) return { providerId, modelId: choice.modelId }
    const models = await listOperonModels().catch(() => [])
    const fallback = models[0]?.id
    return fallback ? { providerId, modelId: fallback } : { blocker: NO_MODEL, reason: { kind: 'no-model' } }
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
  private async blocker(): Promise<{ blocker: string; reason: AssistantBlockerReason } | undefined> {
    const config = this.getConfig()
    for (const choice of [config.main, config.worker]) {
      const resolved = await this.resolveChoice(choice)
      if ('blocker' in resolved) return resolved
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
      return id
    },
    // The main agent's message is its own rewording; the user's words are what it acts on.
    continueTask: (id, message) => {
      // A coding agent's task id leads to its conversation (the main agent may use either tool).
      const chatId = this.coding.chatOf(id)
      if (chatId == null) return this.workers.continue(id, message, this.latestUserText())
      this.coding.send(chatId, message, {})
      return Promise.resolve('continued' as const)
    },
    stopTask: (id) => this.stopActivity(id),
    listTasks: () =>
      this.storage
        .assistantActivityList(LISTED_TASKS)
        .filter((a) => a.agent !== 'main')
        .map((a) => ({ id: a.id, title: a.title, status: a.status, summary: a.summary })),
    progress: (activityId, text) => {
      if (!this.workers.progress(activityId, text) || this.workers.isUnattended(activityId)) return
      void this.toMain({ text: `[Progress from task ${activityId}] ${text}`, cause: { kind: 'progress', activityId } })
    },
    finish: (activityId, args) => this.workers.finish(activityId, args),
    heartbeatDone: (activityId, args) => this.workers.heartbeatDone(activityId, args),
    onFileWritten: (name, role) => this.onFileWritten(name, role),
    schedules: {
      list: () => this.schedules.list(),
      create: (input) => this.schedules.create(input),
      update: (id, patch) => this.schedules.update(id, patch),
      remove: (id) => this.schedules.remove(id),
    },
    coding: {
      models: async (types, query) => {
        const available = codingAgentIds()
        const unknown = types.filter((t) => !available.includes(t))
        if (unknown.length) throw new Error(`Not available: ${unknown.join(', ')}. Available agents: ${available.join(', ') || 'none'}`)
        return JSON.stringify({ agents: await agentModelCatalog(types.length ? types : available, query, 'coding_agents') })
      },
      start: async (input) => {
        const available = codingAgentIds()
        if (!available.includes(input.providerId)) throw new Error(`Available agents: ${available.join(', ') || 'none'}`)
        const activity = await this.coding.start(input)
        return `Started in conversation chat_id ${activity.coding!.chatId} (task ${activity.id}). The user sees a card for it in this thread. You get a notice when it finishes or needs the user; end your turn rather than polling.`
      },
      send: (chatId, message, title) => {
        this.coding.send(chatId, message, title ? { title } : {})
        return 'Sent. You get a notice when it finishes or needs the user.'
      },
      status: (chatId) => JSON.stringify(this.coding.status(chatId)),
      stop: (chatId) => (this.coding.stop(chatId) ? 'Stopped.' : 'It was not running.'),
    },
    actions: {
      addProject: async (input) => {
        const result = await this.operonActions().addProject(input)
        this.emit({ type: 'projects' })
        return result
      },
      githubPrs: (projectId, state) => this.operonActions().githubPrs(projectId, state),
      githubPr: (projectId, number) => this.operonActions().githubPr(projectId, number),
      githubPrCreate: (workspaceId, input) => this.operonActions().githubPrCreate(workspaceId, input),
      createWorkspace: async (input) => {
        const result = await this.operonActions().createWorkspace(input)
        this.emit({ type: 'projects' })
        return result
      },
      boardList: (projectId, status) => this.operonActions().boardList(projectId, status),
      boardGet: (projectId, task) => this.operonActions().boardGet(projectId, task),
      boardCreate: (projectId, input) => this.operonActions().boardCreate(projectId, input),
      boardUpdate: (projectId, task, updates) => this.operonActions().boardUpdate(projectId, task, updates),
      boardComment: (projectId, task, body) => this.operonActions().boardComment(projectId, task, body),
    },
    // Built on first use: field initializers run before the constructor has `storage`.
    operon: {
      workspaceList: () => this.operonState().workspaceList(),
      workspaceOverview: (id) => this.operonState().workspaceOverview(id),
      waitingList: () => this.operonState().waitingList(),
    },
  }

  private operon?: OperonState
  private operonState(): OperonState {
    this.operon ??= createOperonState(this.storage)
    return this.operon
  }

  private actions?: OperonActions
  /** Board changes are recorded under the assistant's name, as it is when they happen. */
  private operonActions(): OperonActions {
    this.actions ??= createOperonActions(this.storage, () => parseIdentity(readProfileFile('identity').content).name ?? 'Assistant')
    return this.actions
  }

  private onFileWritten(name: ProfileFileName, role: AssistantRole): void {
    // The main agent's own edits are not echoed back to it; anyone else's (the wrap-up) are.
    if (role === 'main') this.onProfileChanged(name, true)
    this.emit({ type: 'file', file: readProfileFile(name) })
  }

  /**
   * Services the heartbeat can call, by the names its session has them under, with the plugin's own
   * name beside a plugin's ("plugin_grafana (Grafana)") so heartbeat.md can name either. On an
   * external agent that is exactly what the worker gets mounted ({@link workerServiceServers});
   * Operon's own harness loads the user's MCP config and the plugins itself. (node_repl is a tool,
   * not a service.)
   */
  private async connectors(providerId: AssistantProviderId | undefined): Promise<string[]> {
    const external = providerId !== undefined && providerId !== 'custom'
    const names = external
      ? new Set(Object.keys(workerServiceServers(providerId)))
      : new Set([...Object.keys(await loadUserMcpServers()), ...Object.keys(pluginManager.mcpServerConfigs())])
    names.delete('node_repl')
    // Not signed in: all it offers is "connect first". The heartbeat card says so (withSignInState),
    // and a section that needs it is reported as not done.
    for (const plugin of pluginMcpNeedingSignIn()) names.delete(external ? plugin.name : plugin.runtimeName)
    const pluginName = new Map(listPluginMcpMounts().flatMap((m) => [[m.name, m.pluginName], [m.runtimeName, m.pluginName]] as const))
    return [...names].sort().map((name) => {
      const plugin = pluginName.get(name)
      return plugin && plugin !== name ? `${name} (${plugin})` : name
    })
  }

  /** The heartbeat, carrying the plugins it skips because they aren't signed in. */
  private withSignInState(schedules: AssistantSchedule[]): AssistantSchedule[] {
    const byPlugin = new Map(pluginMcpNeedingSignIn().map((p) => [p.pluginId, { pluginId: p.pluginId, name: p.pluginName }]))
    const notConnected = [...byPlugin.values()]
    return schedules.map((s) => (s.builtin === 'heartbeat' && notConnected.length ? { ...s, notConnected } : s))
  }

  private workerInstructions(kind: WorkerKind, unattended: boolean): string {
    const locale = this.storage.get<string>(LOCALE_KEY)
    if (kind === 'heartbeat') return buildHeartbeatInstructions(filesRecord(), this.heartbeatConnectors, locale)
    return buildWorkerInstructions(filesRecord(), { surfaces: workerSurfaces(), unattended, locale })
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
   * everything, so the session is renewed at the next chance; memory.md changes
   * often and reach the main agent as a note ahead of its next input — unless it made the edit.
   */
  /**
   * The main agent edits memory.md with its own file tools. What it added this turn shows on its
   * reply ("Remembered: …"), and the change isn't echoed back to it as someone else's.
   */
  private onMainTurnMemory(before: { memory: string }, reminder: ContextReminder): void {
    const after = peekProfileFile('memory')
    if (after === before.memory) return
    reminder.mark('memory')
    for (const line of addedFacts(before.memory, after)) this.projector.remember(line)
  }

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
    if (
      stored?.sessionId &&
      stored.providerId === agent.providerId &&
      stored.modelId === agent.modelId &&
      stored.promptRevision === MAIN_PROMPT_REVISION &&
      !rotationDue(startedAt, Date.now())
    ) {
      try {
        return await this.startMain(agent, { generation: stored.generation, sessionId: stored.sessionId })
      } catch (error) {
        console.warn('[assistant] could not resume the main session, starting a new one:', error)
      }
    }
    // Starting over (first use, a day-old session, a new agent or prompt, or one that would not resume).
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
    // Not taken as seen: the main agent edits these files itself, and the watcher still has to see that.
    const reminder = new ContextReminder(() => listProfileFiles(false))
    const filesBefore = () => ({ memory: peekProfileFile('memory') })
    let memoryBefore = filesBefore()
    const session = await openRuntimeSession({
      providerId: agent.providerId as WorkerAgent['providerId'],
      modelId: agent.modelId,
      kind: 'main',
      caller: { role: 'main' },
      cwd: ASSISTANT_DIR,
      instructions: buildMainInstructions(filesRecord(), this.storage.get<string>(LOCALE_KEY), seed),
      ...(resumed ? { sessionId: from.sessionId } : {}),
    })
    reminder.markAll()
    const record: StoredSession = {
      generation,
      providerId: agent.providerId,
      modelId: agent.modelId,
      promptRevision: MAIN_PROMPT_REVISION,
      ...(resumed ? { sessionId: from.sessionId } : {}),
    }
    this.storage.set(SESSION_KEY, record)
    if (!resumed) {
      if (seed) this.storage.set(SEED_KEY, { generation, text: seed })
      else this.storage.delete(SEED_KEY)
      this.storage.set(STARTED_KEY, Date.now())
    }
    const channel = new AgentChannel(session, {
      onTurnStart: (input) => {
        memoryBefore = filesBefore()
        this.projector.begin(input?.tag as Cause | undefined)
      },
      onPart: (part) => {
        try {
          this.projector.part(part)
        } catch (error) {
          console.error('[assistant] failed to project a part', part.type, error)
        }
      },
      onTurnEnd: (end) => {
        this.onMainTurnMemory(memoryBefore, reminder)
        this.projector.end(end)
      },
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
      this.wrapUps++
      try {
        const session = await openRuntimeSession({
          providerId: agent.providerId,
          modelId: agent.modelId,
          kind: 'unattended',
          caller: { role: 'wrapup', id },
          cwd: ASSISTANT_WRAPUP_DIR,
          writableDirs: [ASSISTANT_DIR],
          instructions: buildWrapUpInstructions(filesRecord(), this.storage.get<string>(LOCALE_KEY)),
        })
        const channel = new AgentChannel(session, {
          onApproval: async () => ({ type: 'deny', reason: `Only the files in ${ASSISTANT_DIR} can be changed here.` }),
        })
        try {
          const before = peekProfileFile('memory')
          await channel.deliver({
            text: `Here is the stretch of the conversation that just ended. Bring memory.md and the day notes up to date, then reply Done.\n\n<conversation>\n${buildWrapUpTranscript(messages, activities)}\n</conversation>`,
          })
          await channel.whenIdle()
          const changed = peekProfileFile('memory') !== before
          console.log(`[assistant] wrap-up of ${new Date(from).toISOString()}–${new Date(to).toISOString()}: memory.md ${changed ? 'updated' : 'unchanged'}`)
        } finally {
          await channel.dispose()
        }
      } finally {
        // After the file watcher's debounce, so its last edit is still credited to the assistant.
        setTimeout(() => this.wrapUps--, 1_000)
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
    if (blocker) return { status: 'error', error: blocker.blocker }
    return this.schedules.isHeartbeat(job.id) ? this.runHeartbeat(job) : this.runScheduled(job)
  }

  /**
   * When the last heartbeat that actually finished started. A run that broke off (or never
   * reported) doesn't count: what came up while it was down is still news to the next one.
   */
  private lastCompletedCheck(job: CronjobTask): number | undefined {
    return this.storage.assistantRunList(job.id, 100).find((r) => r.outcome !== 'failed')?.at
  }

  private async runHeartbeat(job: CronjobTask): Promise<Awaited<ReturnType<AssistantCronRunner>>> {
    const config = this.getConfig()
    const now = Date.now()
    const quiet = inQuietHours(new Date(now), config.quietStart, config.quietEnd)
    const files = filesRecord()
    // The agent it will run on decides the services' names; with none, the start below fails anyway.
    const agent = await this.agentFor('heartbeat').catch(() => undefined)
    await ensurePluginsLoaded()
      .then(() => checkPluginSignIns())
      .catch((error: unknown) => console.error('[assistant] plugin load failed:', error))
    this.emit({ type: 'schedules', schedules: this.withSignInState(this.schedules.list()) })
    const connectors = await this.connectors(agent?.providerId)
    const logRun = (outcome: ScheduleRunOutcome, note?: string, activityId?: string) =>
      this.schedules.recordRun({ id: randomUUID(), scheduleId: job.id, at: now, outcome, ...(note ? { note } : {}), ...(activityId ? { activityId } : {}) })

    // Nothing under the checklist's own headings and nothing in progress — but what waits under
    // "Later" still has to go out once quiet hours end, so that alone is work too.
    const told = heartbeatTold(files.heartbeat.content)
    if (!heartbeatHasWork(files.memory.content, files.heartbeat.content) && !(told.includes('### Later') && !quiet)) {
      logRun('silent', NOTHING_TO_CHECK_NOTE)
      return { status: 'success', output: 'Nothing new' }
    }

    this.heartbeatConnectors = connectors
    const { id, done } = await this.workers.start({
      kind: 'heartbeat',
      title: 'Heartbeat',
      prompt: buildHeartbeatPrompt(
        this.lastCompletedCheck(job),
        quiet ? { start: config.quietStart, end: config.quietEnd } : undefined,
      ),
      unattended: true,
      visible: false,
    })
    const outcome = await done
    const args = outcome.finish?.tool === 'heartbeat_done' ? outcome.finish.args : undefined
    // Ending without heartbeat_done means the check wasn't done: it must not read as "nothing new",
    // and must not move "the last check" past what it never looked at.
    if (outcome.end !== 'completed' || outcome.error || !args) {
      const reason = outcome.error ?? (args ? outcome.activity.summary : 'Ended without reporting what it checked (no heartbeat_done).')
      logRun('failed', reason)
      return { status: 'error', error: reason }
    }

    // Its record of what the user has been told, as it says it is now. Read the file again first:
    // the checklist above may have been edited while it ran, and only its own section is replaced.
    if (typeof args.told === 'string') {
      const current = readProfileFile('heartbeat').content
      const next = withHeartbeatTold(current, args.told)
      if (next !== current) {
        writeProfileFile('heartbeat', next, 'assistant')
        this.emit({ type: 'file', file: readProfileFile('heartbeat') })
      }
    }

    const findings = (Array.isArray(args.findings) ? args.findings : [])
      .filter((f) => typeof f.text === 'string' && f.text.trim())
      .map((f) => ({ text: f.text.trim(), urgent: f.urgent === true }))
    // Reported under the checklist section's heading, which is already what the user reads.
    const unchecked = (Array.isArray(args.unchecked) ? args.unchecked : [])
      .filter((u) => typeof u.check === 'string' && u.check.trim())
      .map((u) => (typeof u.reason === 'string' && u.reason.trim() ? `${u.check.trim()} (${u.reason.trim()})` : u.check.trim()))
    const uncheckedNote = unchecked.length ? unchecked.join(', ') : undefined
    // Quiet hours: the check was told to keep all but the urgent for later; hold it to that.
    const sayNow = quiet ? findings.filter((f) => f.urgent) : findings
    if (!sayNow.length) {
      // A check that didn't happen must not read as "nothing new".
      if (uncheckedNote) logRun('partial', uncheckedNote)
      else logRun('silent')
      // Nothing worth continuing: the run log line is the whole record.
      this.forgetWorkerSession(id)
      return { status: 'success', output: 'Nothing new' }
    }
    const activity = outcome.activity
    activity.title = summaryLine(sayNow[0]!.text).slice(0, 80) || 'Heartbeat'
    activity.summary = sayNow.map((f) => f.text).join(' · ')
    activity.report = sayNow.map((f) => `- ${f.urgent ? '(urgent) ' : ''}${f.text}`).join('\n')
    this.saveActivity(activity)
    logRun('found', uncheckedNote ? `${sayNow[0]!.text} · couldn't check ${uncheckedNote}` : sayNow[0]!.text, id)
    this.tellMain(
      [
        '[Heartbeat] Noticed in the background, worth telling the user now:',
        ...sayNow.map((f) => `- ${f.urgent ? '(urgent) ' : ''}${f.text}`),
      ].join('\n'),
      { kind: 'heartbeat', activityId: id },
    )
    return { status: 'success', output: sayNow.map((f) => f.text).join('\n') }
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
      schedules: this.withSignInState(this.schedules.list()),
      typing: this.typing,
      ...(blocker ? { blocker: blocker.blocker, blockerReason: blocker.reason } : {}),
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

  /** @param id the client's own id for it (it shows the message before this returns); a fresh one otherwise. */
  async send(text: string, attachments: AssistantAttachment[] = [], id?: string): Promise<AssistantMessage> {
    const message: AssistantMessage = {
      id: id ?? randomUUID(),
      role: 'user',
      text,
      createdAt: Date.now(),
      ...(attachments.length ? { attachments } : {}),
    }
    this.storage.assistantMessageUpsert(message)
    this.emit({ type: 'message', message })
    const input = buildUserInput(text, attachments)
    // Not awaited: reaching the main agent (opening its session, the first time) can take seconds,
    // and the composer waits on this request. Two sends in a row still arrive in order — the
    // session is opened once (ensureMain) and each delivery queues behind the last.
    void this.toMain({ text: input.text, images: input.images, cause: { kind: 'user' } }, message.createdAt).catch((error: unknown) =>
      this.sayFromHost(error instanceof Error ? error.message : String(error)),
    )
    return message
  }

  /**
   * Carry on the tasks the app's last run cut off, each on its own session where it had one. Once:
   * the list is taken. Failures only reach the log — the activity then stays as it was left,
   * stopped, and the user can still pick it up from there.
   */
  resumeInterrupted(): void {
    const cut = this.interrupted
    this.interrupted = []
    for (const [id, run] of cut) {
      void this.workers
        .resume(id, run)
        .catch((error: unknown) => console.warn(`[assistant] could not carry on interrupted task ${id}:`, error))
    }
  }

  async stopActivity(id: string): Promise<boolean> {
    const chatId = this.coding.chatOf(id)
    if (chatId != null) return this.coding.stop(chatId)
    this.approvals.expireFor(id)
    return this.workers.stop(id)
  }

  /** The drawer's input: straight to the worker, running or finished — the thread is not involved. */
  async followUp(id: string, text: string): Promise<'delivered' | 'continued' | 'missing'> {
    const activity = this.storage.assistantActivityGet(id)
    if (!activity) return 'missing'
    try {
      if (activity.coding) {
        this.coding.send(activity.coding.chatId, text)
        return activity.status === 'running' ? 'delivered' : 'continued'
      }
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

/** The coding agents installed here that the assistant may start in a workspace. */
function codingAgentIds(): string[] {
  return getProviders()
    .filter((p) => p.available && (SUPPORTED_EXTERNAL_AGENT_IDS as readonly string[]).includes(p.id))
    .map((p) => p.id)
}

export function getAssistantRuntime(storage: Storage): AssistantRuntime {
  instance ??= new AssistantRuntime(storage)
  return instance
}

/**
 * At startup: when the app's last run cut tasks off mid-way, bring the assistant up and carry them
 * on. Otherwise the assistant stays unstarted — starting it is what turns the heartbeat on, which
 * must wait for someone to actually use it.
 */
export function resumeInterruptedAssistantWork(storage: Storage): void {
  const cut = storage.get<Record<string, InFlightRun>>(WORKER_RUNS_KEY)
  if (!cut || Object.keys(cut).length === 0) return
  getAssistantRuntime(storage).resumeInterrupted()
}
