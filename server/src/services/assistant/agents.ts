import { randomUUID } from 'crypto'
import {
  readStreamAsAsyncIterable,
  RuntimeInjectionUnavailableError,
  type PermissionDecision,
  type RuntimeMcpServers,
  type AgentInput,
  type AgentSession,
  type RuntimeStreamPart,
} from '@operon/agent-runtime'
import { runAgentTurn } from '../ai/agent-turn.js'
import { extractAssistantText } from '../ai/message-utils.js'
import { getSessionManager } from '../ai/state.js'
import type { HostSessionOptions } from '../ai/session-options.js'
import { mcpCliName, userMcpServersForCli, withApiToken } from '../mcp-config.js'
import { ensurePluginsLoaded } from '../operon-runtime/plugins.js'
import {
  ASSISTANT_WORKER_PARAM,
  assistantConversationId,
  assistantKeyQuery,
  type AssistantCaller,
} from './node-repl-bridge.js'

/**
 * The agents the assistant runs on, and how each of its sessions is opened on them
 * (docs/assistant/design.md §2.1, §7). The main agent and the workers each run on whichever
 * agent the user picked in Settings — operon (`custom`), Codex, Claude Code or OpenCode — through
 * the same runtime the coding chats use. Everything the assistant needs from that runtime lives
 * here: the per-role permission mode, the URLs of its own tools, and `AgentChannel`, which drives
 * one session a turn at a time.
 */

export const ASSISTANT_PROVIDERS = ['custom', 'claude-code', 'codex', 'opencode'] as const
export type AssistantProviderId = (typeof ASSISTANT_PROVIDERS)[number]

export function isAssistantProvider(id: string): id is AssistantProviderId {
  return (ASSISTANT_PROVIDERS as readonly string[]).includes(id)
}

/** Which session is being opened: the permission mode follows from it. */
export type SessionKind = 'main' | 'worker' | 'unattended'

/**
 * Each agent's own permission modes — no judge of the assistant's own (§7). Verified against
 * each provider's `modes` list. What a mode still asks reaches the assistant as an approval.
 */
const MODES: Record<AssistantProviderId, Record<SessionKind, string>> = {
  // manual | workspace | auto | yolo                   (services/operon-runtime/index.ts)
  custom: { main: 'manual', worker: 'auto', unattended: 'auto' },
  // default | auto | acceptEdits | plan | bypassPermissions | dontAsk   (providers/claude/config.ts)
  'claude-code': { main: 'default', worker: 'auto', unattended: 'auto' },
  // requestApproval | approveForMe | fullAccess | plan  (providers/codex/index.ts)
  codex: { main: 'requestApproval', worker: 'approveForMe', unattended: 'approveForMe' },
  // build | plan | fullAccess                            (providers/opencode/index.ts)
  opencode: { main: 'build', worker: 'build', unattended: 'build' },
}

export function modeFor(providerId: AssistantProviderId, kind: SessionKind): string {
  return MODES[providerId][kind]
}

export const PROVIDER_LABEL: Record<AssistantProviderId, string> = {
  custom: 'Operon',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

function apiBase(): string {
  return `http://127.0.0.1:${process.env.OPERON_PORT ?? '3100'}/api`
}

/** MCP server name of the assistant's own tools, per kind of session. */
function toolServerName(caller: AssistantCaller): string {
  return caller.role === 'main' ? 'assistant' : `assistant_${caller.role}`
}

/**
 * What a worker's node_repl is called on an agent. Codex users who run the ChatGPT app have a
 * stdio `node_repl` of its own in `~/.codex/config.toml`; Codex merges same-named entries field
 * by field, so ours (a URL) on top of it is a server with both `command` and `url`, which Codex
 * rejects — the session never starts ("url is not supported for stdio"). So on Codex ours gets
 * another name and theirs is switched off for the session ({@link disabledMcpServers}): left on,
 * the model could drive the browser through it and skip our approvals and audit.
 */
export function nodeReplServerName(providerId: AssistantProviderId): string {
  return providerId === 'codex' ? 'operon_node_repl' : 'node_repl'
}

/** The agent's own servers this session must not load (see {@link nodeReplServerName}). */
export function disabledMcpServers(providerId: AssistantProviderId, servers: RuntimeMcpServers): string[] {
  const name = nodeReplServerName(providerId)
  return name !== 'node_repl' && name in servers ? ['node_repl'] : []
}

/**
 * The user's own services for a worker on this agent — Settings → MCP and the plugins', mounted
 * the same way chats mount them. The heartbeat is told exactly these names, so what it is told it
 * can check is what it has. (node_repl is a tool, not a service, and is mounted on its own.)
 */
export function workerServiceServers(providerId: AssistantProviderId): RuntimeMcpServers {
  const cli = mcpCliName(providerId)
  if (!cli) return {}
  const servers: RuntimeMcpServers = userMcpServersForCli(cli)
  delete servers.node_repl
  return servers
}

/**
 * The servers a session of the assistant gets: its own tools, a worker's services, and for a worker node_repl (web,
 * Chrome, Mac apps) when Settings allow any of it. Each URL names the session and carries the
 * process key. Separate server names per role keep OpenCode, which shares one client per name
 * in a directory, from offering a worker the main agent's tools.
 */
export function sessionMcpServers(
  caller: AssistantCaller,
  nodeRepl: boolean,
  providerId: AssistantProviderId,
): RuntimeMcpServers {
  const id = caller.id ? `&id=${encodeURIComponent(caller.id)}` : ''
  const servers: RuntimeMcpServers = {
    ...(caller.role === 'worker' ? workerServiceServers(providerId) : {}),
    [toolServerName(caller)]: {
      type: 'http',
      url: withApiToken(`${apiBase()}/assistant-mcp?${assistantKeyQuery()}&role=${caller.role}${id}`),
    },
  }
  if (nodeRepl && caller.role === 'worker' && caller.id) {
    servers[nodeReplServerName(providerId)] = {
      type: 'http',
      url: withApiToken(`${apiBase()}/node-repl-mcp?${assistantKeyQuery()}&${ASSISTANT_WORKER_PARAM}=${encodeURIComponent(caller.id)}`),
    }
  }
  return servers
}

export interface OpenParams {
  providerId: AssistantProviderId
  /** Empty: the agent's own default model. */
  modelId: string
  kind: SessionKind
  caller: AssistantCaller
  cwd: string
  instructions: string
  nodeRepl?: boolean
  /** The agent's own session id, to resume. */
  sessionId?: string
}

/** Open (or resume) one of the assistant's sessions on the runtime the chats use. */
export async function openRuntimeSession(params: OpenParams): Promise<AgentSession> {
  // The plugins' servers come from the plugin store, which is empty until loaded — chats load it
  // before building theirs (chat-flow.ts); a worker can be the first thing to run after startup.
  await ensurePluginsLoaded().catch((error) => console.error('[assistant] plugin load failed:', error))
  const mcpServers = sessionMcpServers(params.caller, params.nodeRepl ?? false, params.providerId)
  const disabled = disabledMcpServers(params.providerId, mcpServers)
  const runtimeParams: HostSessionOptions = {
    cwd: params.cwd,
    ...(params.modelId ? { model: params.modelId } : {}),
    mode: modeFor(params.providerId, params.kind),
    // The skills say "node_repl"; under another name the model has to be told it is the same thing.
    instructions:
      disabled.length > 0
        ? `${params.instructions}\n\nHere the node_repl MCP server is named "${nodeReplServerName(params.providerId)}": wherever a skill says node_repl, use its js tool.`
        : params.instructions,
    mcpServers,
    ...(disabled.length > 0 ? { codex: { disabledMcpServers: disabled } } : {}),
    interactive: params.caller.role === 'main',
    opencode: { callerTag: assistantConversationId(params.caller) },
    ...(params.sessionId ? { resume: params.sessionId } : {}),
  }
  return getSessionManager().createStandaloneSession(params.providerId, runtimeParams)
}

/** What a turn is fed: text, and images when the user sent some. */
export interface TurnInput {
  text: string
  images?: ReadonlyArray<{ data: string; mediaType: string }>
  /** The host's own note on why this was handed over; given back when its turn starts. */
  tag?: unknown
}

function toAgentInput(input: TurnInput): AgentInput {
  if (!input.images?.length) return input.text
  return [
    ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
    ...input.images.map((image) => ({ type: 'image' as const, image: image.data, mediaType: image.mediaType })),
  ]
}

export interface TurnEnd {
  /** Everything the agent said in the turn. */
  text: string
  error?: string
  aborted: boolean
}

export interface ChannelHooks {
  /** A turn starts on `input` — or, without one, a turn the agent started on its own. */
  onTurnStart?(input?: TurnInput): void
  onPart?(part: RuntimeStreamPart): void
  onTurnEnd?(end: TurnEnd): void
  /** The agent's own mode left this call to a person. */
  onApproval(toolName: string, input: unknown): Promise<PermissionDecision>
  onSessionId?(sessionId: string): void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error')
}

/**
 * One agent session, driven a turn at a time. What arrives while a turn runs is injected into it
 * when the agent can take that (text only); otherwise it waits and becomes the next turn, so
 * nothing is dropped and turns never overlap. A turn the agent starts on its own (Claude Code
 * picking up an injection after its turn ended) is followed the same way.
 */
export class AgentChannel {
  private running = false
  private readonly queue: TurnInput[] = []
  private controller: AbortController | undefined
  private idleWaiters: Array<() => void> = []
  private disposed = false
  /** The session id last passed to `onSessionId`. */
  private reportedSessionId: string | undefined

  constructor(
    readonly session: AgentSession,
    private readonly hooks: ChannelHooks,
  ) {
    session.onBackground?.((event) => {
      if (event.type !== 'turn' || this.disposed) return
      void this.follow(event.parts)
    })
  }

  get busy(): boolean {
    return this.running || this.queue.length > 0
  }

  /** The agent's own id for this session, once it has one. */
  get sessionId(): string | undefined {
    return this.session.id
  }

  /**
   * Hand the agent something. Idle: a turn starts. Busy: injected into the running turn if the
   * agent takes injections, else queued for the next turn.
   */
  async deliver(input: TurnInput): Promise<'turn' | 'injected' | 'queued'> {
    if (this.disposed) throw new Error('This session is closed.')
    if (!this.running) {
      this.queue.push(input)
      void this.drain()
      return 'turn'
    }
    if (!input.images?.length && this.session.inject) {
      try {
        await this.session.inject(input.text)
        return 'injected'
      } catch (error) {
        if (!(error instanceof RuntimeInjectionUnavailableError)) console.warn('[assistant] injecting into a running turn failed:', errorText(error))
      }
    }
    this.queue.push(input)
    return 'queued'
  }

  /** Stop the running turn and drop what was waiting. */
  abort(): void {
    this.queue.length = 0
    this.controller?.abort()
    this.session.abort()
  }

  /** Resolves when no turn is running and nothing waits. */
  whenIdle(): Promise<void> {
    if (!this.busy) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.queue.length = 0
    this.controller?.abort()
    await this.session.close('discard').catch(() => undefined)
    this.settleIdle()
  }

  private settleIdle(): void {
    if (this.busy && !this.disposed) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (let input = this.queue.shift(); input && !this.disposed; input = this.queue.shift()) {
        await this.turn(input)
      }
    } finally {
      this.running = false
      this.settleIdle()
    }
  }

  private async turn(input: TurnInput): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    this.hooks.onTurnStart?.(input)
    let error: string | undefined
    let text = ''
    try {
      const { preparedParts, done } = runAgentTurn(this.session, {
        requestId: randomUUID(),
        input: toAgentInput(input),
        signal: controller.signal,
        assistantMessageId: randomUUID(),
        originalMessages: [],
        onPart: (part) => this.onPart(part, (message) => (error ??= message)),
        onSessionId: (id) => this.reportSessionId(id),
      })
      // The consumer branch of the tee must be drained; the parts already went to onPart.
      for await (const _ of readStreamAsAsyncIterable(preparedParts)) {
        // drained
      }
      text = extractAssistantText((await done).message)
    } catch (e) {
      error ??= errorText(e)
    } finally {
      if (this.controller === controller) this.controller = undefined
    }
    this.reportSessionId(this.session.id)
    this.hooks.onTurnEnd?.({ text, ...(error && !controller.signal.aborted ? { error } : {}), aborted: controller.signal.aborted })
  }

  /** A turn the agent started on its own: shown like any other, never overlapping one of ours. */
  private async follow(parts: AsyncIterable<RuntimeStreamPart>): Promise<void> {
    if (this.running) {
      for await (const part of parts) this.onPart(part, () => undefined)
      return
    }
    this.running = true
    this.hooks.onTurnStart?.()
    let error: string | undefined
    let text = ''
    try {
      for await (const part of parts) {
        if (part.type === 'text-delta') text += (part as { text?: string }).text ?? ''
        this.onPart(part, (message) => (error ??= message))
      }
    } catch (e) {
      error = errorText(e)
    } finally {
      this.running = false
    }
    this.hooks.onTurnEnd?.({ text: text.trim(), ...(error ? { error } : {}), aborted: false })
    if (this.queue.length) void this.drain()
    else this.settleIdle()
  }

  /** Once per new id: the agent's session id, as soon as anything knows it. */
  private reportSessionId(id: string | undefined): void {
    if (!id || id === this.reportedSessionId) return
    this.reportedSessionId = id
    this.hooks.onSessionId?.(id)
  }

  private onPart(part: RuntimeStreamPart, noteError: (message: string) => void): void {
    // Codex's parts carry no session id, but it has its thread from the start: ask, so a turn a
    // restart cuts off already has its session on disk.
    this.reportSessionId(this.session.id)
    if (part.type === 'tool-approval-request') {
      const call = (part as { toolCall?: { toolName?: string; input?: unknown } }).toolCall ?? {}
      const approvalId = (part as { approvalId: string }).approvalId
      void this.hooks
        .onApproval(call.toolName ?? '', call.input)
        .catch((): PermissionDecision => ({ type: 'deny', reason: 'The approval could not be handled.' }))
        .then((decision) => this.session.respond(approvalId, decision))
    }
    if (part.type === 'error') noteError(errorText((part as { error?: unknown }).error))
    this.hooks.onPart?.(part)
  }
}
