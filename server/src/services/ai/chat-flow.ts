import { chatEnvironments, clearPendingEnvironments, guardEnvironmentChange } from '../chat-environments.js'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai'
import { getSessionManager, getProjectStorage, getChatHistoryService, getChatStorage, getAgentFinishCallback, getNotificationStorage } from './state.js'
import { notify } from '../notification-service.js'
import { observePendingInputPart, clearPendingApprovals } from './chat-pending-input.js'
// Registers the inbox as a subscriber to pending input.
import './approval-inbox.js'
import { OPERON_OWN_MCP_SERVERS, resolveMcpServersForSession } from '../mcp-config.js'
import { ensurePluginsLoaded } from '../operon-runtime/plugins.js'
import { additionalSshRefs, sshProfile } from '../ssh-environments.js'
import { SPEC_CHAT_HINT } from '../spec/prompts.js'
import type { ChatMetadata } from '../../types/chat.js'
import type {
  AiChatRequest,
  ChatRecordState,
  AssistantContinuationState,
  StartChatOptions,
} from './types.js'
import { latestUserInput, mergeConsecutiveSameRole, normalizeUiMessagesFileAttachments } from './message-utils.js'
import {
  resolveProviderId,
  findLatestUserMessage,
  findLastAssistantMessage,
  createErrorResponse,
  resolveWorkspaceCwd,
} from './helpers.js'
import { captureCheckpointIfNeeded, captureTurnEndSnapshot } from './rewind.js'
import {
  prepareChatRecord,
  persistSessionId,
  createReplyWriter,
  hasPersistableAssistantMessage,
  hasCheckpointContent,
  checkpointGapMs,
  mergeAssistantMetadata,
  beginAssistantMessage,
  endAssistantMessage,
} from './persistence.js'
import { runAgentTurn } from './agent-turn.js'
import { TurnStream } from './turn-stream.js'
import { recordUsageSample } from '../analytics/cache-monitor.js'
import {
  isUserFacingRuntimeError,
  type AgentSession,
  type RuntimeStreamPart,
} from '@operon/agent-runtime'
import {
  beginChatTurn,
  markChatTurnReady,
  emitChatTurnStarted,
  emitChatTurnFinished,
  registerChatTurnAbort,
  type ChatTurnAdmission,
  type ChatTurnFinished,
} from './chat-turn-lifecycle.js'
import { buildCompactAwareView } from '../compact-service.js'

// A server-delivered result must retain the launching chat's MCP context and
// instructions. Weak keys follow SessionManager's session lifetime.
const chatContexts = new WeakMap<object, Pick<AiChatRequest, 'agentContext' | 'instructions' | 'env'>>()

/** The text an error chunk carries: only what a provider wrote for the user, never internals. */
const userFacingStreamError = (error: unknown): string =>
  isUserFacingRuntimeError(error) ? error.message : 'An error occurred.'

/**
 * Set up and start one turn on a chat: resolve the provider session, persist the
 * prompt and run the agent into the turn's stream. Internal — every caller goes
 * through `runChatTurn`, which owns the turn's lifecycle.
 */
async function startChat(
  payload: AiChatRequest,
  clientSignal: AbortSignal,
  options: StartChatOptions,
  stream: TurnStream,
) {
  const sessionManager = getSessionManager()
  const chatHistoryService = getChatHistoryService()
  const requestId = payload.requestId ?? randomUUID()
  const rawMessages: UIMessage[] = payload.messages
  // Model-facing view only. It inlines attachment bytes as base64 (that is what
  // model APIs take) and rewrites non-image files into text references — neither
  // belongs in the transcript. Persist `rawMessages` instead, or every turn with
  // an image would write those bytes straight back into the DB row the
  // attachment store just moved them out of.
  const normalizedMessages = normalizeUiMessagesFileAttachments(rawMessages)
  const existingChat = payload.chatId ? chatHistoryService?.getChatMeta(payload.chatId) : undefined
  const storedSshId = existingChat?.metadata?.sshEnvironment?.id
  // Environments still to declare: a new chat's selection, or what a chat created ahead of its first
  // turn asked for. A chat with a session keeps them in the session's declaration instead.
  const pendingEnvironments = existingChat
    ? (existingChat.sessionId ? [] : existingChat.metadata?.additionalSshEnvironments ?? [])
    : undefined
  const providerId = (storedSshId || pendingEnvironments?.length) && payload.providerId === undefined ? 'custom' : resolveProviderId(payload)
  if (payload.chatId && payload.sshEnvironmentId !== undefined && payload.sshEnvironmentId !== storedSshId) {
    throw new Error('The execution environment is fixed after the first message.')
  }
  const sshId = payload.chatId ? storedSshId : payload.sshEnvironmentId
  if (sshId !== undefined && (typeof sshId !== 'string' || providerId !== 'custom')) {
    throw new Error('SSH environments are available for Operon chats.')
  }
  const additional = pendingEnvironments ?? (payload.chatId ? [] : additionalSshRefs(payload.additionalSshEnvironmentIds, sshId, payload.localEnvironmentCwd))
  if (additional.length && providerId !== 'custom') throw new Error('SSH environments are available for Operon chats.')
  const sshEnvironment = sshId === undefined ? undefined : sshProfile(existingChat?.metadata?.sshEnvironment ?? { id: sshId, name: '' })
  if (sshEnvironment && existingChat) payload = { ...payload, workspaceId: existingChat.workspaceId }
  const latestPayloadMessage = normalizedMessages[normalizedMessages.length - 1]
  const latestUserMessage = findLatestUserMessage(normalizedMessages)

  let dbHistory: UIMessage[] | undefined
  let messagesForModel: UIMessage[] | undefined
  let chatRecord: ChatRecordState | undefined
  let continuation: AssistantContinuationState | null = null

  // An assistant-last request (e.g. a declined Codex plan) continues that
  // message for every provider. The SDK seeds assembly with its existing parts;
  // the stream id and persistence target must identify the same message.
  if (
    chatHistoryService && (payload.chatId ?? 0) > 0 &&
    (providerId === 'custom' || latestPayloadMessage?.role === 'assistant')
  ) {
    const dbEntry = chatHistoryService.getChat(payload.chatId!)
    dbHistory = normalizeUiMessagesFileAttachments(dbEntry.messages as UIMessage[])
    const meta = existingChat
    if (!meta) {
      throw new Error(`Chat history not found for chatId=${payload.chatId}`)
    }

    if (latestPayloadMessage?.role !== 'user') {
      continuation = findLastAssistantMessage(dbHistory)
      chatRecord = {
        chatId: payload.chatId!,
        sessionId: meta.sessionId,
      }
      if (providerId === 'custom') messagesForModel = buildCompactAwareView(dbHistory)
    }
  }

  if (!chatRecord && normalizedMessages.length > 0 && options?.skipUserMessagePersistence) {
    chatRecord = {
      chatId: payload.chatId ?? 0,
      sessionId: existingChat?.sessionId,
    }
    if (providerId === 'custom') {
      messagesForModel = buildCompactAwareView(
        dbHistory && latestUserMessage ? [...dbHistory, latestUserMessage] : latestUserMessage ? [latestUserMessage] : []
      )
    }
  } else if (!chatRecord && normalizedMessages.length > 0) {
    chatRecord = prepareChatRecord(payload, rawMessages, sshEnvironment && { id: sshEnvironment.id, name: sshEnvironment.name }, additional)
    if (providerId === 'custom') {
      messagesForModel = buildCompactAwareView(
        dbHistory && latestUserMessage ? [...dbHistory, latestUserMessage] : latestUserMessage ? [latestUserMessage] : []
      )
    }
  } else if (!chatRecord) {
    chatRecord = {
      chatId: payload.chatId ?? 0,
      sessionId: existingChat?.sessionId,
    }
  }

  const assistantMessageId = continuation?.assistantMessage.id ?? randomUUID()

  const chatId = chatRecord.chatId
  if ((sshEnvironment || additional.length) && chatId > 0) options?.onChatRecord?.(chatId)
  const workflowAgent = existingChat?.metadata?.workflowAgent
  // With an SSH root, MCP clients still run on this machine: in an attached local directory, else
  // the chat's workspace.
  const hostWorkspace = sshEnvironment
    ? (existingChat?.sessionId ? await chatEnvironments(existingChat) : additional).find(ref => ref.id === 'local')?.cwd
      ?? (payload.workspaceId ? getProjectStorage()?.getWorkspace(payload.workspaceId)?.worktreePath : undefined)
    : undefined
  const cwd = sshEnvironment?.cwd ?? workflowAgentCwd(workflowAgent) ?? resolveWorkspaceCwd(payload.workspaceId)
  // Backfill the spec source chat with the server-assigned chatId. The route
  // sets agentId/projectId but leaves sourceChatId unset because a new chat's
  // first message has no chatId yet; chatRecord.chatId is the real id even on
  // message #1 (prepareChatRecord created the row). Doing it here — before the
  // session is created — bakes task_board into the session on the first turn,
  // so it's never rebuilt (setting sourceChatId on a later turn would change the
  // session params key and destroy the cached stateful-provider session).
  if (
    payload.agentContext &&
    payload.agentContext.channelId == null &&
    payload.agentContext.sourceChatId == null &&
    chatId > 0
  ) {
    payload.agentContext.sourceChatId = chatId
  }
  // operonrepl (Computer Use / Browser Use) is scoped by the conversation itself,
  // not by the optional agent-communication context. Plain chats, cron jobs and
  // canvases still have a chatId and must receive their own persistent kernel.
  const mcpContext = chatId > 0 ? { ...payload.agentContext, chatId, cwd: sshEnvironment ? hostWorkspace : cwd } : payload.agentContext
  // Plugin MCP servers are merged in from the plugin store, which must be loaded first.
  await ensurePluginsLoaded().catch((error) => console.error('[plugins] load failed:', error))
  // Workflow sub-agents retain their existing tool set.
  const mcpServers = workflowAgent ? undefined : resolveMcpServersForSession(providerId, mcpContext)
  // OperonSpec hint for a direct workspace chat (sourceChatId set): opt-in
  // guidance delivered as session
  // instructions layered once onto the provider's system prompt. It used to ride every user message
  // as a <system-reminder>; that block was journaled with the message by every
  // stateful provider, so a long chat carried one copy per turn. sourceChatId
  // is resolved above, before the session exists, so the hint is baked in on
  // message #1 and never changes the session's params afterwards.
  const instructions = payload.agentContext?.sourceChatId != null
    ? [payload.instructions?.trim(), SPEC_CHAT_HINT].filter(Boolean).join('\n\n')
    : payload.instructions
  // Codex's approveForMe reviewer judges each MCP call and can't tell the host
  // from an outside destination; our own servers skip it (see OPERON_OWN_MCP_SERVERS).
  // Codex only: the options block is part of the session key for every provider.
  const approvedMcpServers = providerId === 'codex' && mcpServers
    ? OPERON_OWN_MCP_SERVERS.filter((name) => name in mcpServers)
    : []
  const session = await sessionManager.getOrCreate(chatId, providerId, {
    cwd,
    env: payload.env,
    model: payload.modelId,
    mode: payload.modeId,
    effort: payload.thinkingLevel,
    serviceTier: payload.serviceTier,
    resume: chatRecord.sessionId,
    mcpServers,
    instructions,
    ...(sshEnvironment || additional.length ? { operon: { sshEnvironment, additionalSshEnvironments: additional, hostWorkspace } } : {}),
    ...(approvedMcpServers.length > 0 ? { codex: { approvedMcpServers } } : {}),
    ...(chatId > 0 ? { opencode: { callerTag: String(chatId) } } : {}),
    ...resolveForkSource(chatId),
  })
  const request = sessionManager.startRequest(chatId, requestId)

  if (clientSignal) {
    if (clientSignal.aborted) request.abortController.abort()
    else clientSignal.addEventListener('abort', () => request.abortController.abort(), { once: true })
  }
  request.abortController.signal.addEventListener('abort', () => session.runtime.abort(), { once: true })

  if (!messagesForModel && dbHistory && providerId === 'custom') {
    messagesForModel = buildCompactAwareView(dbHistory)
  } else if (!messagesForModel) {
    messagesForModel = normalizedMessages
  }

  const messages = messagesForModel.length > 0
    ? mergeConsecutiveSameRole(await convertToModelMessages(messagesForModel))
    : []
  const checkpointMessageUid = await captureCheckpointIfNeeded({
    chatId,
    cwd,
    rawMessages,
    skipSnapshot: payload.skipSnapshot || !!sshEnvironment,
  })

  let resultMessage: UIMessage | undefined
  let turnError: string | undefined
  const sessionIdRef: { value?: string } = { value: chatRecord.sessionId }
  if ((sshEnvironment || additional.length) && session.runtime.id) persistSessionId(chatId, sessionIdRef, session.runtime.id)
  // The session declares them now; leaving the request would make it a second record.
  if (additional.length && session.runtime.id) {
    const storage = getChatStorage()
    if (storage) clearPendingEnvironments(storage, chatId)
  }

  // Keyed by the reply's id: the first save adds it (or updates the assistant
  // message a continuation picked up), later ones update it in place.
  const replyWriter = createReplyWriter({
    chatId,
    modelId: payload.modelId,
    providerId: payload.providerId,
    assistantMetadata: options?.assistantMetadata,
  })

  const persistResponseMessage = async (responseMessage: UIMessage): Promise<void> => {
    try {
      if (
        chatHistoryService && chatId > 0 &&
        hasPersistableAssistantMessage(mergeAssistantMetadata(responseMessage, options?.assistantMetadata))
      ) {
        const result = replyWriter.save(responseMessage, sessionIdRef.value)
        if (!result.saved) turnError = 'Failed to save the assistant response'
      }
    } catch (err) {
      turnError = err instanceof Error ? err.message : String(err)
      console.error('[AI] Background persistence error:', err)
    } finally {
      const runtimeSessionId = session.runtime.id
      if (runtimeSessionId) {
        persistSessionId(chatId, sessionIdRef, runtimeSessionId)
      }
    }
  }

  // Save the reply as it settles, not only when the turn ends, so a turn that
  // dies with the process keeps what it had done. Not for a turn that keeps its
  // prompt out of the transcript until it succeeds (compact): a half-written
  // summary saved mid-turn is exactly what it is avoiding.
  const checkpointEnabled = chatHistoryService != null && chatId > 0 && !options?.skipUserMessagePersistence
  const onCheckpoint = checkpointEnabled
    ? (message: UIMessage): number | void => {
        if (!hasCheckpointContent(message)) return
        const result = replyWriter.save(message, sessionIdRef.value)
        if (result.saved) return checkpointGapMs(result.bytes)
      }
    : undefined

  request.abortController.signal.throwIfAborted()

  // Execution + normalization is the shared core; chat-specific persistence and
  // SSE wrapping stay here (and in handleChat).
  if (chatId > 0) clearPendingApprovals(chatId)
  if (checkpointEnabled) beginAssistantMessage(chatId, assistantMessageId)
  stream.messageId = assistantMessageId
  const { done } = runAgentTurn(session.runtime, {
    requestId,
    input: latestUserInput(messages),
    signal: request.abortController.signal,
    assistantMessageId,
    originalMessages: normalizedMessages,
    onSessionId: (sessionId) => persistSessionId(chatId, sessionIdRef, sessionId),
    onCheckpoint,
    onChunk: (chunk) => stream.publish(chunk),
    onError: userFacingStreamError,
    onPart: (part: RuntimeStreamPart) => {
      if (part.type === 'error') turnError = 'error' in part ? String(part.error) : 'Agent execution failed'
      if (chatId > 0) observePendingInputPart(chatId, part, { userFacing: options?.notifyInbox === true })
      options?.onPart?.(part)
    },
    ...(chatId > 0
      ? {
          onUsage: (usage) =>
            recordUsageSample(
              {
                conversationId: String(chatId),
                providerId: payload.providerId ?? session.providerId,
                modelId: payload.modelId,
              },
              usage,
            ),
        }
      : {}),
    asGoal: payload.asGoal,
    traffic: {
      chatId,
      providerId: payload.providerId ?? session.providerId,
      modelId: payload.modelId,
      modeId: payload.modeId,
      cwd,
    },
  })

  const persistDone = done
    .then(async ({ message, error }) => {
      if (error !== undefined) turnError ??= error instanceof Error ? error.message : String(error)
      resultMessage = message
      await persistResponseMessage(message)
    })
    .catch((err) => {
      turnError = err instanceof Error ? err.message : String(err)
      console.error('[AI] Persistence stream error:', err)
    })
    .finally(async () => {
      endAssistantMessage(chatId, assistantMessageId)
      // Close this turn's diff interval. Must land before the SSE stream ends
      // (handleChat awaits persistDone in its finally), because the client
      // refetches turn diffs the moment the stream settles — a later capture
      // would leave that fetch reading a turn with no upper bound.
      if (checkpointMessageUid) {
        await captureTurnEndSnapshot({ chatId, cwd, messageUid: checkpointMessageUid })
      }
    })

  return {
    chatId,
    requestId,
    assistantMessageId,
    session,
    stream,
    persistDone,
    completion: (): ChatTurnFinished => ({
      chatId,
      turnId: requestId,
      status: request.abortController.signal.aborted ? 'cancelled' as const : turnError ? 'failed' as const : 'completed' as const,
      message: resultMessage,
      prompt: latestUserMessage,
      error: turnError,
    }),
    finish: () => sessionManager.finishRequest(chatId, requestId),
  }
}

/**
 * Set up a turn whose output is already on its way (`ChatTurnOptions.output`):
 * the agent started replying on its own, so there is no prompt to persist and no
 * provider call to make. Only the reply is mapped, published and saved.
 */
function startOutputTurn(
  payload: AiChatRequest,
  output: AsyncIterable<RuntimeStreamPart>,
  signal: AbortSignal,
  options: ChatTurnOptions,
  stream: TurnStream,
) {
  const chatId = payload.chatId ?? 0
  if (chatId <= 0) throw new Error('A turn with its output on the way needs a chat')
  const requestId = payload.requestId ?? randomUUID()
  const assistantMessageId = randomUUID()
  // Stop (`abortChat`) aborts the chat's live runtime, which ends `output`.
  const session: AgentSession = {
    id: undefined,
    send: async function* () {
      yield* output
    },
    abort: () => undefined,
    close: async () => undefined,
    respond: () => false,
  }
  const writer = createReplyWriter({ chatId, modelId: payload.modelId, providerId: payload.providerId,
    assistantMetadata: options.assistantMetadata })
  const sessionId = getChatHistoryService()?.getChatMeta(chatId)?.sessionId
  let resultMessage: UIMessage | undefined
  let turnError: string | undefined
  let aborted = false

  beginAssistantMessage(chatId, assistantMessageId)
  stream.messageId = assistantMessageId
  const { done } = runAgentTurn(session, {
    requestId,
    input: '',
    signal,
    assistantMessageId,
    originalMessages: [],
    onChunk: (chunk) => stream.publish(chunk),
    onCheckpoint: (message) => {
      if (!hasCheckpointContent(message)) return
      const result = writer.save(message, sessionId)
      if (result.saved) return checkpointGapMs(result.bytes)
    },
    onError: userFacingStreamError,
    onPart: (part) => {
      if (part.type === 'abort') aborted = true
      if (part.type === 'error') {
        const error = (part as { error?: unknown }).error
        turnError ??= error instanceof Error ? error.message : String(error ?? 'stream error')
      }
      observePendingInputPart(chatId, part, { userFacing: options.notifyInbox === true })
      options.onPart?.(part)
    },
  })

  const persistDone = done
    .then(({ message, error }) => {
      if (error !== undefined) turnError ??= error instanceof Error ? error.message : String(error)
      const hasContent = message.parts.some((p) => p.type !== 'step-start')
      if (!hasContent && !turnError) return
      // The SDK masks a stream error behind a generic notice and drops it from
      // the assembled message; a failed model call would show as an empty bubble.
      const toPersist: UIMessage = hasContent
        ? message
        : { ...message, parts: [...message.parts, { type: 'text', text: `Error: ${turnError}` }] }
      if (!writer.save(toPersist, sessionId).saved) {
        turnError = 'Failed to save the assistant response'
        return
      }
      resultMessage = toPersist
    })
    .catch((err) => {
      turnError = err instanceof Error ? err.message : String(err)
      console.error('[AI] Persistence stream error:', err)
    })
    .finally(() => endAssistantMessage(chatId, assistantMessageId))

  return {
    chatId,
    requestId,
    assistantMessageId,
    session: undefined,
    stream,
    persistDone,
    completion: (): ChatTurnFinished => ({
      chatId,
      turnId: requestId,
      status: aborted || signal.aborted ? 'cancelled' as const : turnError ? 'failed' as const : 'completed' as const,
      message: resultMessage,
      error: turnError,
    }),
    finish: () => undefined,
  }
}

/**
 * A workflow sub-agent's chat runs where the agent was put — often a disposable
 * worktree of its own, not its workspace's checkout. Once that is gone (it is
 * removed when the agent ends), a later turn runs in the workspace instead.
 */
function workflowAgentCwd(workflowAgent: ChatMetadata['workflowAgent']): string | undefined {
  const cwd = workflowAgent?.cwd
  return cwd && existsSync(cwd) ? cwd : undefined
}

/**
 * A side chat branches off its parent's provider session on its first turn.
 *
 * Passed on every turn, not just the first: the provider forks only while the
 * side chat has no `sessionId` of its own, and once the fork lands its id is
 * persisted and resumed like any other chat's. Keeping this attached is what
 * lets a session rebuilt mid-conversation (fast mode toggled, MCP map changed)
 * still know it owns a fork, rather than treating the branch as a stray session
 * and leaving it behind.
 *
 * Returns an empty object for ordinary chats, and for a parent that has not
 * started a provider session yet (nothing to fork from — that chat then just
 * starts fresh).
 */
function resolveForkSource(chatId: number): { fork?: { from: string; ephemeral: boolean } } {
  if (chatId <= 0) return {}
  const storage = getChatStorage()
  const meta = storage?.getChatMeta(chatId)
  if (meta?.tp !== 'side') return {}
  const parentChatId = meta.metadata?.parentChatId
  if (parentChatId == null) return {}
  const parentSessionId = storage?.getChatMeta(parentChatId)?.sessionId
  if (!parentSessionId) return {}
  return { fork: { from: parentSessionId, ephemeral: true } }
}

/**
 * First ~180 chars of the turn's final assistant reply, for the inbox row body.
 * Reads the persisted tail (runs after persistDone), so it reflects what the
 * user will actually see in the conversation. Best-effort — null falls back to
 * the generic body.
 */
function finalReplySnippet(chatId: number): string | null {
  try {
    const tail = getChatStorage()?.getChatMessages(chatId, { limit: 10 })
    const messages = (tail?.messages ?? []) as UIMessage[]
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (message?.role !== 'assistant') continue
      const text = (message.parts ?? [])
        .map((part) => {
          const p = part as { type?: string; text?: unknown }
          return p.type === 'text' && typeof p.text === 'string' ? p.text : ''
        })
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (!text) return null
      return text.length > 180 ? `${text.slice(0, 180)}…` : text
    }
  } catch (err) {
    console.error('[Inbox] finalReplySnippet failed:', err)
  }
  return null
}

/**
 * Session instructions for an external agent's child chat.
 *
 * Whatever a child ends its turn with is delivered to the delegating agent, not
 * to the user — so a question asked in plain text wakes the parent model, which
 * then tends to answer it on the user's behalf. Asking through the provider's
 * question tool instead keeps the child's turn open, blocked on the user, and
 * nothing reaches the parent until they answer in the child's tab.
 */
export const EXTERNAL_AGENT_CHILD_INSTRUCTIONS = `## Working as a delegated agent

Another agent started this conversation on the user's behalf. When your turn ends, your final message is sent back to that agent, not shown to the user as a question.

If you need anything from the user (a decision, a clarification, a confirmation), ask it with your tool for asking the user a question, and wait for the answer. Do not end your turn with a question written as plain text: the delegating agent would receive it instead of the user.`

function withExternalAgentChildInstructions(instructions?: string): string {
  const own = instructions?.trim()
  if (own?.includes(EXTERNAL_AGENT_CHILD_INSTRUCTIONS)) return own
  return [own, EXTERNAL_AGENT_CHILD_INSTRUCTIONS].filter(Boolean).join('\n\n')
}

/** A turn refused because the chat is already taken (see `ChatTurnOptions.admission`). */
export class ChatBusyError extends Error {
  constructor() {
    super('Chat is busy')
    this.name = 'ChatBusyError'
  }
}

export interface ChatTurnOptions extends StartChatOptions {
  /**
   * Ends the turn when it aborts — for a caller whose turn must not outlive it
   * (an IM conversation reset, a plugin request). The chat's own Stop
   * (`/api/ai/abort`) works either way.
   */
  signal?: AbortSignal
  /** See `ChatTurnAdmission`; a refused turn throws `ChatBusyError`. Defaults to `force`. */
  admission?: ChatTurnAdmission
  /**
   * A turn in a person's conversation — sent from a chat tab, or delivered into
   * one on their behalf. It restores the configuration the chat was launched
   * with, and when it ends it runs the agent-finish callback and leaves an
   * inbox notification. Turns the server runs for itself (cron, canvas,
   * channels, tasks) stay silent.
   */
  userFacing?: boolean
  /**
   * The reply is already on its way: the agent started it on its own (Claude
   * Code answering a background agent that finished, an operon lead woken by a
   * teammate's report). The turn takes no prompt and makes no provider call; it
   * maps, publishes and saves `output` like any other reply. Needs `chatId`.
   */
  output?: AsyncIterable<RuntimeStreamPart>
}

/** A running chat turn. Observe it through `stream` (every surface does) and `ended`. */
export interface ChatTurn {
  chatId: number
  requestId: string
  assistantMessageId: string
  /** The turn's reply; `stream.subscribe()` is how anyone watches it. */
  stream: TurnStream
  /** Resolves once the reply is saved and the turn is over. Never rejects. */
  ended: Promise<ChatTurnFinished>
}

/**
 * Settings a chat tab may not send yet (its catalog still loading) or must not
 * override (an agent conversation's own model) — restored from what the chat
 * was launched with and what is saved on it.
 */
function withChatLaunchContext(payload: AiChatRequest): AiChatRequest {
  // A server-owned child keeps its selected configuration even when a newly
  // attached UI has not loaded its model catalog yet.
  const stored = payload.chatId ? getChatStorage()?.getChatMeta(payload.chatId) : undefined
  const existingSession = payload.chatId ? getSessionManager().get(payload.chatId) : undefined
  const context = existingSession ? chatContexts.get(existingSession) : undefined
  if (context) payload = { ...payload,
    agentContext: payload.agentContext ?? context.agentContext,
    instructions: payload.instructions ?? context.instructions,
    env: payload.env ?? context.env,
  }
  // A workflow sub-agent's chat keeps what it ran on when a person picks it up
  // (the tab sends `tp: 'subagent'` for every agent conversation). What the
  // tab sends is not used: until its catalog loads it can hold a stand-in
  // model or mode. A pick made in the tab is saved at once instead
  // (`/cc/dynamic-set` → `rememberChatTurnSettings`), so it is what is read
  // here, for the tab's turns and for the ones its parent starts alike.
  if (stored?.tp === 'workflow-agent') {
    payload = { ...payload, providerId: stored.providerId, modelId: stored.model,
      modeId: stored.metadata?.modeId, thinkingLevel: stored.thinkingLevel, tp: 'workflow-agent' }
  }
  if (stored?.metadata?.externalAgent) {
    payload = { ...payload, providerId: stored.providerId, modelId: stored.model,
      modeId: stored.metadata.modeId, workspaceId: stored.workspaceId,
      thinkingLevel: stored.thinkingLevel, agentContext: undefined, tp: 'subagent',
      instructions: withExternalAgentChildInstructions(payload.instructions) }
  }
  return payload
}

/** What a finished turn in a person's conversation sets off. */
function afterUserFacingTurn(chatId: number, workspaceId: number | undefined): void {
  try {
    getAgentFinishCallback()?.(chatId)
  } catch (err) {
    console.error('[AI] agent finish callback failed:', err)
  }
  // Inbox: record a "finished responding" notification for this workspace chat.
  const notificationStorage = getNotificationStorage()
  if (!notificationStorage || chatId <= 0) return
  const title = getChatHistoryService()?.getChatMeta(chatId)?.title
  notify(notificationStorage, {
    kind: 'chat_complete',
    severity: 'info',
    sourceKey: `chat:${chatId}`,
    chatId,
    workspaceId: workspaceId ?? null,
    title: title?.trim() || 'Workspace chat',
    body: finalReplySnippet(chatId) ?? 'Agent finished responding',
  })
}

/**
 * Run one turn on a chat. The only way a chat turn starts — a person's message,
 * a delivered notice, a channel or task agent, cron, canvas, IM, compact, a
 * reply the agent started on its own (`output`) — so
 * every one of them is admitted, stoppable, announced, visible live on every
 * surface showing the chat, and reported when it ends.
 *
 * The turn runs on the node and does not depend on anyone watching it: the
 * caller gets a handle, not a stream it must drain. Throws when the turn could
 * not start (`ChatBusyError`, a setup failure), already reported as failed.
 */
export async function runChatTurn(payload: AiChatRequest, options: ChatTurnOptions = {}): Promise<ChatTurn> {
  payload = { ...payload, requestId: payload.requestId ?? randomUUID() }
  const requestId = payload.requestId!
  const admission = options.admission ?? 'force'
  // Exists before the turn is announced, so a surface that attaches the moment
  // it hears of the turn finds its stream. A turn kept off screen (compact's
  // summary, about to replace the transcript) still streams into one, just not
  // one registered for anyone to attach to.
  const stream = new TurnStream(requestId)
  const registered = options.visible === false ? undefined : stream
  // Admission and setup reservation happen together, before any asynchronous
  // provider work.
  if (payload.chatId) {
    guardEnvironmentChange(payload.chatId)
    const running = admission === 'idle-only' && getSessionManager().get(payload.chatId)?.activeRequest != null
    if (running || !beginChatTurn(payload.chatId, requestId, { admission, stream: registered })) throw new ChatBusyError()
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  let unregisterAbort = payload.chatId ? registerChatTurnAbort(payload.chatId, abort) : undefined
  const release = () => {
    options.signal?.removeEventListener('abort', abort)
    unregisterAbort?.()
  }

  if (options.userFacing) payload = withChatLaunchContext(payload)
  emitChatTurnStarted(payload)
  let ctx: Awaited<ReturnType<typeof startChat>> | ReturnType<typeof startOutputTurn>
  try {
    ctx = options.output
      ? startOutputTurn(payload, options.output, controller.signal, options, stream)
      : await startChat(payload, controller.signal, options, stream)
  } catch (err) {
    release()
    if (payload.chatId) {
      getSessionManager().finishRequest(payload.chatId, requestId)
      emitChatTurnFinished({ chatId: payload.chatId, turnId: requestId,
        status: controller.signal.aborted ? 'cancelled' : 'failed', prompt: findLatestUserMessage(payload.messages),
        error: err instanceof Error ? err.message : String(err) })
    }
    throw err
  }
  // A follow-up the user sends from the tab reuses this turn's MCP context and
  // instructions (see withChatLaunchContext).
  if (ctx.session) chatContexts.set(ctx.session, { agentContext: payload.agentContext, instructions: payload.instructions, env: payload.env })
  // A new chat's id is only known now.
  if (!payload.chatId && ctx.chatId > 0) {
    beginChatTurn(ctx.chatId, ctx.requestId, { admission: 'force', stream: registered })
    unregisterAbort = registerChatTurnAbort(ctx.chatId, abort)
  }
  markChatTurnReady(ctx.chatId, ctx.requestId)

  const ended = (async (): Promise<ChatTurnFinished> => {
    await ctx.persistDone
    ctx.finish()
    if (options.userFacing) afterUserFacingTurn(ctx.chatId, payload.workspaceId)
    // Last, after the reply is saved: a viewer whose stream ends here and reads
    // history finds the reply there.
    ctx.stream.end()
    release()
    const completion = ctx.completion()
    emitChatTurnFinished(completion)
    return completion
  })()

  return {
    chatId: ctx.chatId,
    requestId: ctx.requestId,
    assistantMessageId: ctx.assistantMessageId,
    stream: ctx.stream,
    ended,
  }
}

/**
 * A subscription to a turn's stream as the AI SDK's UI-message-stream response
 * — the reply so far, then the rest. Both the POST that starts a turn and the
 * GET that attaches to one answer with this. X-Turn-Id is how a surface tells
 * "the turn I hold" from "a turn a peer started"; X-Message-Id names the reply
 * it rebuilds, so a surface can clear an older copy of it first.
 */
export function turnStreamResponse(stream: TurnStream, options: { chatId?: number } = {}): Response {
  const headers: Record<string, string> = { 'X-Turn-Id': stream.turnId }
  if (stream.messageId) headers['X-Message-Id'] = stream.messageId
  if (options.chatId !== undefined) headers['X-Chat-Id'] = String(options.chatId)
  return createUIMessageStreamResponse({ stream: stream.subscribe(), headers })
}

/**
 * POST /api/ai/chat: start a turn and answer with a subscription to it. A
 * dropped request only ends the subscription — the turn keeps running and the
 * client attaches again — unless the caller passes `clientSignal`, which ends
 * the turn with the request.
 */
export async function handleChat(
  payload: AiChatRequest,
  clientSignal?: AbortSignal,
  options?: { onlyIfIdle?: boolean },
): Promise<Response> {
  let createdChatId: number | undefined
  try {
    const turn = await runChatTurn(payload, {
      userFacing: true,
      notifyInbox: true,
      admission: options?.onlyIfIdle ? 'idle-only' : 'reject',
      signal: clientSignal,
      onChatRecord: (chatId) => { createdChatId = chatId },
    })
    return turnStreamResponse(turn.stream, { chatId: turn.chatId })
  } catch (err) {
    if (err instanceof ChatBusyError) return Response.json({ error: 'Chat is busy' }, { status: 409 })
    const response = createErrorResponse('[AI] Setup Error:', err)
    if (!payload.chatId && createdChatId) response.headers.set('X-Chat-Id', String(createdChatId))
    return response
  }
}
