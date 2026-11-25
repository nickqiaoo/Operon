import { canScheduleAt } from '@shared/scheduled-messages'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { FileUIPart } from 'ai'
import * as aiService from '../services/ai.js'
import { getChatStorage } from '../services/ai/state.js'
import type { PermissionOutcome } from '../services/ai.js'
import type { AiChatRequest } from '../services/ai/types.js'
import { waitForChatTurnIdle } from '../services/ai/chat-turn-lifecycle.js'
import { publishExternalAgentSettings } from '../services/external-agent.js'
import { rememberChatTurnSettings } from '../services/ai/persistence.js'
import { replaceLiveAgent, steerLiveAgent } from '../services/workflow/live-agents.js'
import { getOrCreateWorkspaceAssistant } from '../services/workspace-assistant.js'
import { nameWorkspaceFromMessage, type WorkspaceNamingStorage } from '../services/workspace-naming.js'
import type { AgentBindingStorageAdapter, ChannelStorageAdapter, ProjectStorageAdapter } from '../storage/interface.js'

type AiRouteStorage = Pick<ChannelStorageAdapter, 'getAgentByName' | 'createAgent'> &
  Pick<ProjectStorageAdapter, 'getWorkspace'> &
  Pick<AgentBindingStorageAdapter, 'getBindingByActiveChatId'> &
  WorkspaceNamingStorage

/** The text the user typed across the request's messages, oldest first. */
function userTextOf(messages: unknown[]): string {
  const texts: string[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'user') continue
    const parts = (message as { parts?: unknown }).parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const text = (part as { text?: unknown }).text
        if (typeof text === 'string' && text.trim()) texts.push(text.trim())
      }
    }
  }
  return texts.join('\n\n')
}

/**
 * Give an interactive workspace chat the task-board context it needs, so the
 * agent can `start_spec` from a plain conversation.
 * Derives the project from the chat's workspace and acts as the hidden
 * Workspace Assistant. No-op unless this is a workspace-bound
 * user chat (cronjob/canvas/subagent/linear call startChat directly and never
 * hit this route; a chat with no workspace has no git project to spec against).
 *
 * Deliberately does NOT set sourceChatId here: a brand-new chat's first message
 * carries no chatId yet (the client only learns it from the X-Chat-Id response
 * header), so reading payload.chatId would bail on message #1 and the session
 * would be created without task_board. startChat fills sourceChatId from the
 * server-assigned chatId once chatRecord is resolved — present on message #1,
 * so the session is built with task_board once and never rebuilt (a late
 * sourceChatId would change the session params key and destroy the cached,
 * stateful provider session mid-chat).
 */
export function enrichChatAgentContext(payload: AiChatRequest, storage: AiRouteStorage): void {
  if (
    payload.agentContext || payload.sshEnvironmentId !== undefined ||
    (payload.chatId && getChatStorage()?.getChatMeta(payload.chatId)?.metadata?.sshEnvironment)
  ) return
  if (payload.tp && payload.tp !== 'chat') return
  // A person typing into a task's session (taking over a stuck ticket) speaks for
  // the task's assignee, exactly as the orchestrator does when it wakes that
  // session — otherwise the turn runs as the Workspace Assistant and the task
  // board refuses its status change ("Only the assignee can change…").
  const binding = payload.chatId != null ? storage.getBindingByActiveChatId(payload.chatId) : null
  if (binding?.scopeKind === 'task' && binding.projectId != null) {
    payload.agentContext = { agentId: binding.agentId, projectId: binding.projectId }
    return
  }
  const { workspaceId } = payload
  if (!workspaceId) return
  const workspace = storage.getWorkspace(workspaceId)
  if (!workspace) return
  const assistant = getOrCreateWorkspaceAssistant(storage, {
    provider: payload.providerId,
    model: payload.modelId,
  })
  payload.agentContext = {
    agentId: assistant.id,
    projectId: workspace.projectId,
  }
}

export function aiRoutes(storage: AiRouteStorage, scheduled?: import('../services/scheduled-messages.js').ScheduledMessages) {
  const router = new Hono()

  if (scheduled) {
    router.post('/scheduled', async (c) => {
      const { sendAt, payload } = await c.req.json<{ sendAt: number; payload: AiChatRequest }>()
      const msg = payload?.messages?.[0]
      if (!canScheduleAt(sendAt)) return c.json({ code: 'schedule_time_invalid', error: 'Choose a time within the next 12 hours.' }, 400)
      if (!msg || payload.messages.length !== 1 ||
          msg.role !== 'user' || !msg.id || !Array.isArray(msg.parts) || !msg.parts.length ||
          !msg.parts.every(p => (p.type === 'text' && typeof p.text === 'string') || (p.type === 'file' && typeof p.url === 'string' && !p.url.startsWith('blob:')))) {
        return c.json({ code: 'schedule_message_invalid', error: 'Choose a future time and enter a message.' }, 400)
      }
      return c.json(scheduled.enqueue(sendAt, payload))
    })
    router.get('/scheduled/:chatId', c => c.json(scheduled.list(Number(c.req.param('chatId')))))
    router.delete('/scheduled/:chatId/:id', c => scheduled.cancel(Number(c.req.param('chatId')), c.req.param('id'))
      ? c.json({ success: true }) : c.json({ error: 'This message is no longer pending.' }, 409))
  }

  // POST /api/ai/chat - returns standard AI SDK UIMessageStream response
  router.post('/chat', async (c) => {
    const payload = (await c.req.json()) as AiChatRequest
    // Diagnostic: count chat requests. Two lines with the same lastUserId for a
    // single send ⇒ the client double-fired /api/ai/chat (root of the dup user
    // message + double agent run).
    const msgs: Array<{ role?: string; id?: string }> = Array.isArray(payload?.messages) ? payload.messages : []
    const lastUser = [...msgs].reverse().find((m) => m?.role === 'user')
    console.log('[ai/chat] request', { chatId: payload?.chatId, lastUserId: lastUser?.id, msgCount: msgs.length })
    enrichChatAgentContext(payload, storage)
    // A chat's worktree still under its placeholder name gets one from what was
    // just sent, if that says what the work is (in the background).
    if (payload.workspaceId && msgs[msgs.length - 1]?.role === 'user') {
      void nameWorkspaceFromMessage(storage, payload.workspaceId, userTextOf(msgs))
    }
    // Deliberately NOT passing c.req.raw.signal: a dropped request only ends its
    // subscription, never the turn. Other surfaces may be attached to it via
    // /chat/stream/:chatId, and the requester itself can re-attach after a reload
    // or a tunnel blip. Only a deliberate POST /api/ai/abort ends a turn early.
    const response = await aiService.handleChat(payload)
    return response
  })

  // GET /api/ai/chat/stream/:chatId — attach to the chat's turn. Answers with
  // the reply as it stands, then every chunk after it until the turn ends, over
  // the same response; the SDK rebuilds the assistant message by id, replacing
  // what the client already showed of it. 204 when there is no turn to attach to
  // (the SDK reads that as "nothing to resume"; the client reads history).
  router.get('/chat/stream/:chatId', (c) => {
    const chatId = parseInt(c.req.param('chatId'), 10)
    const stream = Number.isFinite(chatId) ? aiService.getChatTurnStream(chatId) : undefined
    if (!stream) return c.body(null, 204)
    return aiService.turnStreamResponse(stream)
  })

  // GET /api/ai/chat/status — what every chat is doing, on one stream: whether
  // it has a turn, what it waits on a person for, its background sub-agents,
  // its next-prompt guess. It opens with a `sync` frame holding all of it, then
  // sends a frame per change.
  //
  // One stream for every chat, not one per open conversation: the renderer
  // reaches this server over plain HTTP/1.1, where a browser allows 6 sockets per
  // origin, and a handful of per-chat streams filled the pool so every later
  // request — sending a message included — queued behind them. In the app it is
  // one channel of `/api/events` (see app.ts).
  router.get('/chat/status', (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false
      let wake: () => void = () => {}
      const untilClosed = new Promise<void>((resolve) => {
        wake = resolve
      })
      const close = (): void => {
        closed = true
        wake()
      }
      stream.onAbort(close)

      // Subscribe BEFORE the snapshot, not after: a turn starting between the two
      // would otherwise fall through both — absent from the snapshot that was
      // already serialized, and not yet reaching a listener. The overlap can only
      // duplicate an event, and clients are idempotent on turnId; the gap cannot
      // be recovered at all.
      const unsub = aiService.onChatTurnStatus((status) => {
        if (closed) return
        stream.writeSSE({ data: JSON.stringify({ type: 'turn', status }) }).catch(close)
      })
      // What each chat is waiting on a person for (chat-pending-input.ts). Same
      // subscribe-before-snapshot order, same idempotent frames: each one carries
      // the chat's whole pending list, not a delta.
      const unsubPending = aiService.subscribePendingInput((change) => {
        if (closed) return
        const pending = change.pending.map(aiService.summarizePendingInput)
        stream.writeSSE({ data: JSON.stringify({ type: 'pending-input', chatId: change.chatId, pending }) }).catch(close)
      })
      // Background sub-agents per chat (chat-background-tasks.ts), whole list per
      // frame like pending input.
      const unsubBackground = aiService.subscribeBackgroundTasks((change) => {
        if (closed) return
        stream.writeSSE({ data: JSON.stringify({ type: 'background-tasks', chatId: change.chatId, tasks: change.tasks }) }).catch(close)
      })
      // Claude Code's next-prompt guess per chat (chat-prompt-suggestions.ts);
      // `text: null` clears it.
      const unsubSuggestions = aiService.subscribePromptSuggestions((change) => {
        if (closed) return
        stream.writeSSE({ data: JSON.stringify({ type: 'prompt-suggestion', chatId: change.chatId, text: change.text }) }).catch(close)
      })

      // Every chat with a turn. A chat missing from this list has none, which is
      // how one stream answers for conversations the client never named.
      await stream
        .writeSSE({
          data: JSON.stringify({
            type: 'sync',
            turns: aiService.listActiveChatTurns(),
            pendingInput: aiService.listChatsAwaitingInput(),
            backgroundTasks: aiService.listChatBackgroundTasks(),
            promptSuggestions: aiService.listChatPromptSuggestions(),
          }),
        })
        .catch(close)
      await untilClosed
      unsub()
      unsubPending()
      unsubBackground()
      unsubSuggestions()
    })
  })

  // GET /api/ai/chat/:chatId/subagent/:toolUseId — the steps of the sub-agent a
  // chat's Agent (Claude Code) or subagent (OpenCode) call spawned, read from the
  // provider's own record of it. A background agent's card has no other source
  // for them.
  router.get('/chat/:chatId/subagent/:toolUseId', async (c) => {
    const chatId = parseInt(c.req.param('chatId'), 10)
    if (!Number.isFinite(chatId)) return c.json({ error: 'Invalid chat id' }, 400)
    const transcript = await aiService.getSubagentTranscript(chatId, c.req.param('toolUseId'))
    if (!transcript) return c.json({ error: 'Sub-agent transcript not found' }, 404)
    return c.json(transcript)
  })

  // POST /api/ai/permission-response
  router.post('/permission-response', async (c) => {
    const { id, outcome, chatId } = await c.req.json<{ id: string; outcome: PermissionOutcome; chatId: number }>()
    const result = aiService.handlePermissionResponse(id, outcome, chatId)
    return c.json({ success: result })
  })

  // GET /api/ai/pending-approvals/:chatId — the chat's pending tool approvals.
  // Feeds the inbox detail pane's inline Approve/Deny; resolution goes through
  // POST /permission-response like every other approval surface.
  router.get('/pending-approvals/:chatId', (c) => {
    const chatId = parseInt(c.req.param('chatId'), 10)
    return c.json({ approvals: aiService.listPendingApprovals(chatId) })
  })

  // POST /api/ai/session/cleanup
  router.post('/session/cleanup', async (c) => {
    const { chatId } = await c.req.json<{ chatId: number }>()
    const result = aiService.handleSessionCleanup(chatId)
    return c.json({ success: result })
  })

  // POST /api/ai/rewind — unified git-based rewind (provider-agnostic).
  // Reverts only files this chat can claim; anything another chat touched comes
  // back in `skipped`. Re-post with `force` once the user confirms those.
  router.post('/rewind', async (c) => {
    const { chatId, messageUid, cwd, force } = await c.req.json<{
      chatId: number
      messageUid: string
      cwd: string
      force?: boolean
    }>()
    const result = await aiService.rewindToCheckpoint(chatId, messageUid, cwd, { force })
    return c.json(result)
  })

  // GET /api/ai/checkpoints/:chatId — list all checkpoints for a chat
  router.get('/checkpoints/:chatId', (c) => {
    const chatId = parseInt(c.req.param('chatId'), 10)
    const checkpoints = aiService.listCheckpoints(chatId)
    return c.json({ checkpoints })
  })

  // GET /api/ai/turn-diffs/:chatId?cwd= — per-turn file changes for every turn
  router.get('/turn-diffs/:chatId', async (c) => {
    const chatId = parseInt(c.req.param('chatId'), 10)
    const cwd = c.req.query('cwd')
    if (!cwd) return c.json({ error: 'cwd is required' }, 400)
    const result = await aiService.getTurnDiffs(chatId, cwd)
    return c.json(result)
  })

  // GET /api/ai/turn-file-diffs/:chatId?cwd=&messageUid= — all per-file unified
  // diffs for one turn, in one call (review panel's "Last turn" scope).
  // messageUid selects the turn; omit for the most recent.
  router.get('/turn-file-diffs/:chatId', async (c) => {
    const chatId = parseInt(c.req.param('chatId'), 10)
    const cwd = c.req.query('cwd')
    const messageUid = c.req.query('messageUid')
    if (!cwd) return c.json({ error: 'cwd is required' }, 400)
    const result = await aiService.getTurnFileDiffs(chatId, cwd, messageUid)
    return c.json(result)
  })

  // POST /api/ai/undo-rewind — undo the last rewind operation. `files` are the
  // paths that rewind reported changing; restoring just those leaves other
  // chats' edits alone.
  router.post('/undo-rewind', async (c) => {
    const { backupSnapshotId, cwd, files } = await c.req.json<{
      backupSnapshotId: string
      cwd: string
      files?: string[]
    }>()
    const result = await aiService.undoRewind(backupSnapshotId, cwd, files)
    return c.json(result)
  })

  // --- Workflows: one feed over the event log (services/workflow/store.ts) ---

  const sseHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  }

  // GET /api/ai/workflow/runs — recent runs, folded from the log. The panel uses
  // the feed below; this is for one-shot readers.
  router.get('/workflow/runs', (c) => {
    const limitRaw = Number(c.req.query('limit') ?? '50')
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 200) : 50
    return c.json({ runs: aiService.listWorkflowRuns(limit) })
  })

  // GET /api/ai/workflow/feed — SSE: every run's view, kept current. A
  // sub-agent's output is not on it: the agent is a chat, watched on that chat's
  // turn stream (GET /chat/stream/:chatId).
  router.get('/workflow/feed', (c) => {
    const limit = Number.parseInt(c.req.query('limit') ?? '50', 10)
    return new Response(aiService.getWorkflowFeed(Number.isFinite(limit) ? limit : 50), { headers: sseHeaders })
  })

  // POST /api/ai/workflow/run/:runId/stop — abort an in-flight run (→ 'stopped')
  router.post('/workflow/run/:runId/stop', (c) => {
    return c.json(aiService.stopWorkflow(c.req.param('runId')))
  })

  // GET /api/ai/workflow/run/:runId/result — the final result, kept out of the
  // run view because it can be large.
  router.get('/workflow/run/:runId/result', (c) => {
    return c.json(aiService.getWorkflowResult(c.req.param('runId')))
  })

  // GET /api/ai/workflow/run/:runId/script — the script it was launched with,
  // for reading it back in the panel. Off the run view because it is the biggest
  // field a run has and the list would carry one per row.
  router.get('/workflow/run/:runId/script', (c) => {
    return c.json(aiService.getWorkflowScript(c.req.param('runId')))
  })

  // GET /api/ai/workflow/run/:runId/agent/:index/chunks?settled=1 — one
  // sub-agent's recorded output. `settled` leaves out a turn still running: a
  // panel watching that turn's stream renders it from there.
  router.get('/workflow/run/:runId/agent/:index/chunks', (c) => {
    const index = Number.parseInt(c.req.param('index'), 10)
    if (!Number.isFinite(index)) return c.json({ error: 'Invalid agent index' }, 400)
    const settled = c.req.query('settled') === '1'
    return c.json(aiService.getWorkflowAgentChunks(c.req.param('runId'), index, { settled }))
  })

  // POST /api/ai/workflow/run/:runId/agent/:index/steer — message a sub-agent
  // while it works, without stopping it.
  router.post('/workflow/run/:runId/agent/:index/steer', async (c) => {
    const index = Number.parseInt(c.req.param('index'), 10)
    if (!Number.isFinite(index)) return c.json({ success: false, error: 'Invalid agent index' }, 400)
    const { text } = await c.req.json<{ text?: string }>().catch(() => ({ text: undefined }))
    const result = await steerLiveAgent(c.req.param('runId'), index, text ?? '')
    return c.json(result, result.success ? 200 : 409)
  })

  // POST /api/ai/workflow/run/:runId/agent/:index/replace — hand a running
  // sub-agent's work to another provider; the run carries on.
  router.post('/workflow/run/:runId/agent/:index/replace', async (c) => {
    const index = Number.parseInt(c.req.param('index'), 10)
    if (!Number.isFinite(index)) return c.json({ success: false, error: 'Invalid agent index' }, 400)
    const { providerId, modelId } = await c.req
      .json<{ providerId?: string; modelId?: string }>()
      .catch(() => ({ providerId: undefined, modelId: undefined }))
    if (!providerId || !aiService.getSessionManager().hasProvider(providerId)) {
      return c.json({ success: false, error: `Unknown agent: ${providerId ?? '(none)'}` }, 400)
    }
    const result = replaceLiveAgent(c.req.param('runId'), index, { providerId, modelId: modelId || undefined })
    return c.json(result, result.success ? 200 : 409)
  })

  // POST /api/ai/cc/dynamic-set — update a live session's turn settings.
  // Path kept for compatibility; no longer Claude-only.
  router.post('/cc/dynamic-set', async (c) => {
    const payload = await c.req.json<{
      chatId: number
      modelId?: string
      modeId?: string
      thinkingLevel?: string
      serviceTier?: string
    }>()
    const { chatId, modelId, modeId, thinkingLevel } = payload
    const agentMeta = rememberChatTurnSettings(chatId, { modeId, modelId, thinkingLevel })
    if (agentMeta) publishExternalAgentSettings(chatId, agentMeta)
    const result = await aiService.handleCCDynamicSet(chatId, {
      model: modelId,
      mode: modeId,
      effort: thinkingLevel,
      ...('serviceTier' in payload ? { serviceTier: payload.serviceTier === 'fast' ? 'fast' as const : undefined } : {}),
    })
    return c.json(result)
  })

  // POST /api/ai/compact - compact conversation history
  router.post('/compact', async (c) => {
    const payload = await c.req.json<{
      chatId: number
      modelId: string
      providerId?: string
      workspaceId?: number
    }>()
    const result = await aiService.handleCompact(payload)
    return c.json(result, result.success ? 200 : 400)
  })

  // POST /api/ai/abort
  router.post('/abort', async (c) => {
    const { chatId } = await c.req.json<{ chatId: number }>()
    const result = aiService.abortChat(chatId)
    // Don't answer until the aborted turn has finished writing its (partial)
    // assistant message. The client reconciles its transcript against chat
    // history as soon as Stop settles; replying while the write is still in
    // flight hands it a tail without the reply it has on screen, and it then
    // drops everything the turn had already streamed.
    await waitForChatTurnIdle(chatId)
    return c.json({ success: result })
  })

  // POST /api/ai/inject
  router.post('/inject', async (c) => {
    const { chatId, content, turnMessageId, messageId, mode, files } = await c.req.json<{
      chatId: number
      content: string
      turnMessageId?: string
      messageId?: string
      mode?: 'steer' | 'followup'
      files?: FileUIPart[]
    }>()
    const normalizedTurnMessageId =
      typeof turnMessageId === 'string' && turnMessageId.length > 0
        ? turnMessageId
        : undefined
    const normalizedMessageId =
      typeof messageId === 'string' && /^[\w-]{1,128}$/.test(messageId) ? messageId : undefined
    const result = await aiService.injectIntoChat(chatId, content, normalizedTurnMessageId, {
      messageId: normalizedMessageId,
      mode: mode === 'followup' ? 'followup' : 'steer',
      files: Array.isArray(files)
        ? files.filter((file): file is FileUIPart => file?.type === 'file' && typeof file.url === 'string' && typeof file.mediaType === 'string')
        : undefined,
    })
    return c.json(result, result.success ? 200 : 400)
  })

  // GET /api/ai/context-usage/:chatId — detailed context window breakdown.
  //
  // Always 200, unlike its neighbours: the failures here are ordinary states of
  // a chat rather than bad requests — no session open on this node, or a
  // provider that doesn't report context usage at all. The client polls this
  // every few seconds during a turn and already reads `success`, so answering
  // 4xx only filled the browser console with red for a working app.
  router.get('/context-usage/:chatId', async (c) => {
    const chatId = parseInt(c.req.param('chatId'), 10)
    return c.json(await aiService.getContextUsage(chatId))
  })

  // GET /api/ai/claude-usage — account quota, independent of any conversation.
  // `?force=1` is the Refresh button asking to skip the caches on the way down.
  router.get('/claude-usage', async (c) => {
    const result = await aiService.getClaudeUsageLimits({ force: c.req.query('force') === '1' })
    return c.json(result, result.success ? 200 : 400)
  })

  // GET /api/ai/codex-usage — account quota, independent of any conversation
  router.get('/codex-usage', async (c) => {
    const result = await aiService.getCodexUsageLimits({ force: c.req.query('force') === '1' })
    return c.json(result, result.success ? 200 : 400)
  })

  // GET /api/ai/goal/:chatId — current thread goal (for banner rehydration)
  router.get('/goal/:chatId', async (c) => {
    const chatId = parseInt(c.req.param('chatId'), 10)
    const result = await aiService.getChatGoal(chatId)
    return c.json(result, result.success ? 200 : 400)
  })

  // POST /api/ai/goal/clear — clear the goal + stop the pursuit loop
  router.post('/goal/clear', async (c) => {
    const { chatId } = await c.req.json<{ chatId: number }>()
    const result = await aiService.clearChatGoal(chatId)
    return c.json(result, result.success ? 200 : 400)
  })

  // POST /api/ai/goal/status — pause the active goal (resume is driven via /chat)
  router.post('/goal/status', async (c) => {
    const { chatId, status } = await c.req.json<{ chatId: number; status: 'active' | 'paused' }>()
    const result = await aiService.setChatGoalStatus(chatId, status)
    return c.json(result, result.success ? 200 : 400)
  })

  // POST /api/ai/agent-control — provider-supported session runtime control.
  // Generic method+params; the chat UI's Session panel drives this.
  router.post('/agent-control', async (c) => {
    const { chatId, method, params } = await c.req.json<{
      chatId: number
      method: string
      params?: unknown
    }>()
    const result = await aiService.agentControl(chatId, method, params)
    return c.json(result, result.success ? 200 : 400)
  })

  // GET /api/ai/providers
  router.get('/providers', (c) => {
    return c.json(aiService.getProviders())
  })

  // GET /api/ai/providers/:id/models
  router.get('/providers/:id/models', async (c) => {
    const providerId = c.req.param('id')
    const result = await aiService.getProviderModels(providerId)
    return c.json(result)
  })

  return router
}
