import { randomUUID } from 'crypto'
import {
  createUIMessageStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai'
import { getSessionManager, getChatHistoryService, getChatStorage, getAgentFinishCallback, getNotificationStorage } from './state.js'
import { notify } from '../notification-service.js'
import { observeApprovalPart, clearPendingApprovals } from './approval-inbox.js'
import { resolveMcpServersForSession } from '../mcp-config.js'
import { SDD_CREATE_SPEC_TASK_HINT } from '../sdd/sdd-prompt.js'
import type {
  AiChatRequest,
  ChatRecordState,
  AssistantContinuationState,
  StartChatOptions,
} from './types.js'
import { appendTurnReminder, mergeConsecutiveSameRole, normalizeUiMessagesFileAttachments } from './message-utils.js'
import { endComputerUseHostSession } from '../computer-use-presentation.js'
import {
  resolveProviderId,
  findLatestUserMessage,
  findLastAssistantMessage,
  createErrorResponse,
  createChatResponseHeaders,
  resolveWorkspaceCwd,
} from './helpers.js'
import { captureCheckpointIfNeeded, captureTurnEndSnapshot } from './rewind.js'
import {
  prepareChatRecord,
  persistSessionId,
  persistAssistantMessageWithRetry,
  hasPersistableAssistantMessage,
  mergeAssistantMetadata,
} from './persistence.js'
import { runAgentTurn, writePreparedPartToUiStream } from './agent-turn.js'
import { startLiveTurn, pumpToLiveTurn } from './live-turn-hub.js'
import { recordUsageSample } from '../analytics/cache-monitor.js'
import { readStreamAsAsyncIterable, type RuntimeStreamPart } from '@operon/agent-runtime'
import { buildCompactAwareView } from '../compact-service.js'

// ---- Public API ----

export async function startChat(
  payload: AiChatRequest,
  clientSignal?: AbortSignal,
  options?: StartChatOptions,
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
  const providerId = resolveProviderId(payload)
  const latestPayloadMessage = normalizedMessages[normalizedMessages.length - 1]
  const latestUserMessage = findLatestUserMessage(normalizedMessages)

  let dbHistory: UIMessage[] | undefined
  let messagesForModel: UIMessage[] | undefined
  let chatRecord: ChatRecordState | undefined
  let continuation: AssistantContinuationState | null = null

  if (providerId === 'custom' && chatHistoryService && (payload.chatId ?? 0) > 0) {
    const dbEntry = chatHistoryService.getChat(payload.chatId!)
    dbHistory = normalizeUiMessagesFileAttachments(dbEntry.messages as UIMessage[])
    const meta = chatHistoryService.getChatMeta(payload.chatId!)
    if (!meta) {
      throw new Error(`Chat history not found for custom provider chatId=${payload.chatId}`)
    }

    if (latestPayloadMessage?.role !== 'user') {
      continuation = findLastAssistantMessage(dbHistory)
      chatRecord = {
        chatId: payload.chatId!,
        baseRevision: meta.revision,
        sessionId: meta.sessionId,
      }
      messagesForModel = buildCompactAwareView(dbHistory)
    }
  }

  if (!chatRecord && normalizedMessages.length > 0 && options?.skipUserMessagePersistence) {
    const existingMeta = chatHistoryService?.getChatMeta(payload.chatId ?? 0)
    chatRecord = {
      chatId: payload.chatId ?? 0,
      baseRevision: existingMeta?.revision ?? 0,
      sessionId: existingMeta?.sessionId,
    }
    if (providerId === 'custom') {
      messagesForModel = buildCompactAwareView(
        dbHistory && latestUserMessage ? [...dbHistory, latestUserMessage] : latestUserMessage ? [latestUserMessage] : []
      )
    }
  } else if (!chatRecord && normalizedMessages.length > 0) {
    chatRecord = prepareChatRecord(payload, rawMessages)
    if (providerId === 'custom') {
      messagesForModel = buildCompactAwareView(
        dbHistory && latestUserMessage ? [...dbHistory, latestUserMessage] : latestUserMessage ? [latestUserMessage] : []
      )
    }
  } else if (!chatRecord) {
    const existingMeta = chatHistoryService?.getChatMeta(payload.chatId ?? 0)
    chatRecord = {
      chatId: payload.chatId ?? 0,
      baseRevision: existingMeta?.revision ?? 0,
      sessionId: existingMeta?.sessionId,
    }
  }

  const assistantMessageId = continuation?.assistantMessage.id ?? randomUUID()

  const chatId = chatRecord.chatId
  const cwd = resolveWorkspaceCwd(payload.workspaceId)
  // Backfill the SDD promote source with the server-assigned chatId. The route
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
  // node_repl (Computer Use / Browser Use) is scoped by the conversation itself,
  // not by the optional agent-communication context. Plain chats, cron jobs and
  // canvases still have a chatId and must receive their own persistent kernel.
  const mcpContext = chatId > 0
    ? { ...(payload.agentContext ?? {}), chatId, cwd }
    : payload.agentContext
  const mcpServers = resolveMcpServersForSession(providerId, mcpContext)
  const session = await sessionManager.getOrCreate(chatId, providerId, {
    cwd,
    env: payload.env,
    modelId: payload.modelId,
    providerId: payload.providerId,
    modeId: payload.modeId,
    thinkingLevel: payload.thinkingLevel,
    serviceTier: payload.serviceTier,
    sessionId: chatRecord.sessionId,
    mcpServers,
    instructions: payload.instructions,
  })
  const request = sessionManager.startRequest(chatId, requestId)

  if (clientSignal) {
    clientSignal.addEventListener('abort', () => request.abortController.abort(), { once: true })
  }
  request.abortController.signal.addEventListener('abort', () => session.runtime.abort(), { once: true })

  if (!messagesForModel && dbHistory) {
    messagesForModel = buildCompactAwareView(dbHistory)
  } else if (!messagesForModel) {
    messagesForModel = normalizedMessages
  }

  // SDD hint for a direct workspace chat (sourceChatId set): a light, always-on
  // nudge that create_spec_task exists and when to reach for it — the same hint
  // channel agents get. Reminder semantics, so it rides the latest user message
  // as a <system-reminder> block (per turn, works on every provider); the full
  // workflow arrives in the create_spec_task result once the chat actually
  // promotes. Not persisted to history.
  if (payload.agentContext?.sourceChatId != null && messagesForModel.length > 0) {
    messagesForModel = appendTurnReminder(messagesForModel, SDD_CREATE_SPEC_TASK_HINT)
  }

  const messages = messagesForModel.length > 0
    ? mergeConsecutiveSameRole(await convertToModelMessages(messagesForModel))
    : []
  const checkpointMessageUid = await captureCheckpointIfNeeded({
    chatId,
    cwd,
    rawMessages,
    skipSnapshot: payload.skipSnapshot,
  })

  const sessionIdRef: { value?: string } = { value: chatRecord.sessionId }

  const persistResponseMessage = async (responseMessage: UIMessage): Promise<void> => {
    try {
      const messageToPersist = mergeAssistantMetadata(responseMessage, options?.assistantMetadata)
      if (chatHistoryService && chatId > 0 && hasPersistableAssistantMessage(messageToPersist)) {
        await persistAssistantMessageWithRetry({
          chatId,
          baseRevision: chatRecord.baseRevision,
          assistantMessage: messageToPersist,
          replaceFrom: continuation?.assistantIndex,
          modelId: payload.modelId,
          providerId: payload.providerId,
          sessionId: sessionIdRef.value,
        })
      }
    } catch (err) {
      console.error('[AI] Background persistence error:', err)
    } finally {
      const runtimeSessionId = session.runtime.getSessionId?.()
      if (runtimeSessionId) {
        persistSessionId(chatId, sessionIdRef, runtimeSessionId)
      }
    }
  }

  // Execution + normalization is the shared core; chat-specific persistence and
  // SSE wrapping stay here (and in handleChat).
  if (chatId > 0) clearPendingApprovals(chatId)
  const { preparedParts, done } = runAgentTurn(session.runtime, {
    requestId,
    messages,
    signal: request.abortController.signal,
    assistantMessageId,
    originalMessages: normalizedMessages,
    onSessionId: (sessionId) => persistSessionId(chatId, sessionIdRef, sessionId),
    ...(chatId > 0
      ? {
          onPart: (part: RuntimeStreamPart) =>
            observeApprovalPart(chatId, part, options?.notifyInbox === true),
        }
      : {}),
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
    .then(({ message }) => persistResponseMessage(message))
    .catch((err) => {
      console.error('[AI] Persistence stream error:', err)
    })
    .finally(async () => {
      if (chatId > 0) await endComputerUseHostSession(String(chatId))
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
    normalizedMessages,
    preparedParts,
    session,
    sessionId: sessionIdRef,
    persistDone,
    finish: () => sessionManager.finishRequest(chatId, requestId),
  }
}

/**
 * The response headers a late attacher must replay verbatim — the AI SDK keys
 * its UI-message-stream decoding off them (x-vercel-ai-ui-message-stream), so
 * an attach that invents its own headers would be parsed as a plain SSE.
 */
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
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
 * Core chat handler. Returns a standard AI SDK UIMessageStream Response.
 */
export async function handleChat(
  payload: AiChatRequest,
  clientSignal?: AbortSignal
): Promise<Response> {
  try {
    const ctx = await startChat(payload, clientSignal, { notifyInbox: true })

    const clientStream = createUIMessageStream({
      originalMessages: ctx.normalizedMessages,
      generateId: () => ctx.assistantMessageId,
      execute: async ({ writer }) => {
        try {
          for await (const preparedPart of readStreamAsAsyncIterable(ctx.preparedParts)) {
            writePreparedPartToUiStream(writer, preparedPart, ctx.assistantMessageId)
          }
        } finally {
          await ctx.persistDone
          ctx.finish()
          const agentFinishCallback = getAgentFinishCallback()
          if (agentFinishCallback) {
            agentFinishCallback(ctx.chatId)
          }
          // Inbox: record a "finished responding" notification for this workspace
          // chat. handleChat is the user-facing chat path only — cron / canvas /
          // channel / task turns call startChat directly and never reach here, so
          // this won't flood the inbox with background agent turns.
          const notificationStorage = getNotificationStorage()
          if (notificationStorage && ctx.chatId > 0) {
            const title = getChatHistoryService()?.getChatMeta(ctx.chatId)?.title
            notify(notificationStorage, {
              kind: 'chat_complete',
              severity: 'info',
              sourceKey: `chat:${ctx.chatId}`,
              chatId: ctx.chatId,
              workspaceId: payload.workspaceId ?? null,
              title: title?.trim() || 'Workspace chat',
              body: finalReplySnippet(ctx.chatId) ?? 'Agent finished responding',
            })
          }
        }
      },
    })

    const response = createUIMessageStreamResponse({ stream: clientStream })
    const headers = createChatResponseHeaders(response.headers, ctx.chatId)

    // Tee the wire bytes into the live-turn hub so surfaces that did NOT make
    // this request (the web client over the broker tunnel, a second window, the
    // phone) can attach to the same turn via GET /api/ai/chat/live/:chatId.
    // Splitting at the byte level keeps this transparent to the turn itself —
    // the requester's stream is unchanged, and a cancelled requester branch
    // does not stop the hub branch from draining.
    let clientBody = response.body
    if (clientBody && ctx.chatId > 0) {
      const [toRequester, toHub] = clientBody.tee()
      clientBody = toRequester
      const turn = startLiveTurn(ctx.chatId, headersToRecord(headers))
      // Tell the requester which turn its POST opened, so its live-attach
      // watcher can recognise the presence event for this turn as its own.
      headers.set('X-Turn-Id', turn.turnId)
      void pumpToLiveTurn(toHub, turn)
    }

    return new Response(clientBody, {
      status: response.status,
      headers,
    })
  } catch (err) {
    return createErrorResponse('[AI] Setup Error:', err)
  }
}
