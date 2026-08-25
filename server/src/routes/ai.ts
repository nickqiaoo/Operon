import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import * as aiService from '../services/ai.js'
import type { PermissionOutcome } from '../services/ai.js'
import type { AiChatRequest } from '../services/ai/types.js'
import { getOrCreateWorkspaceAssistant, type SddStorage } from '../services/sdd/sdd-service.js'

/**
 * Give an interactive workspace chat the SDD promote source it needs, so the
 * agent can `create_spec_task` from a plain conversation (not just a channel).
 * Derives the project from the chat's workspace and uses the hidden Workspace
 * Assistant as the recorded spec author. No-op unless this is a workspace-bound
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
function enrichChatAgentContext(payload: AiChatRequest, storage: SddStorage): void {
  if (payload.agentContext) return
  if (payload.tp && payload.tp !== 'chat') return
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

export function aiRoutes(storage: SddStorage) {
  const router = new Hono()

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
    // Deliberately NOT passing c.req.raw.signal: a dropped request must not kill
    // the turn. Other surfaces may be attached to it via /chat/live/:chatId, and
    // the requester itself can re-attach after a reload or a tunnel blip. Only a
    // deliberate POST /api/ai/abort ends a turn early.
    const response = await aiService.handleChat(payload)
    return response
  })

  // GET /api/ai/chat/live/:chatId — attach to the turn currently streaming on
  // this chat. Replays the buffered UIMessageChunk bytes from the start, then
  // tails to completion; the SDK reconciles by message/part id so a full replay
  // rebuilds the assistant message without duplicating it. 204 when there is
  // nothing live (the SDK reads that as "nothing to resume").
  router.get('/chat/live/:chatId', (c) => {
    const chatId = parseInt(c.req.param('chatId'), 10)
    const turn = Number.isFinite(chatId) ? aiService.getLiveTurn(chatId) : undefined
    if (!turn) return c.body(null, 204)
    // Replay the turn's own response headers verbatim — the SDK decodes a UI
    // message stream only when it sees x-vercel-ai-ui-message-stream. X-Chat-Id
    // is stripped on purpose: that header is what the broker uses to decide a
    // response is a fresh turn worth buffering, and letting a replay carry it
    // would make the broker open a second buffer over the real one.
    const headers = new Headers(turn.headers)
    headers.delete('X-Chat-Id')
    return new Response(turn.toReadableStream(c.req.raw.signal), { status: 200, headers })
  })

  // GET /api/ai/chat/live-status — presence for EVERY chat, on one stream.
  //
  // Replaces one SSE per open conversation. The renderer reaches this server at
  // http://127.0.0.1:<port> over plain HTTP/1.1, where a browser allows 6 sockets
  // per origin and never multiplexes; a stream that stays open spends one for its
  // whole life, so a handful of open tabs filled the pool and every later request
  // — sending a message included — queued behind connections that never close.
  //
  // Registered before the /:chatId form so 'live-status' with no argument is not
  // read as a chat id.
  router.get('/chat/live-status', (c) => {
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
      const unsub = aiService.subscribeAllLiveTurnPresence((status) => {
        if (closed) return
        stream.writeSSE({ data: JSON.stringify({ type: 'presence', status }) }).catch(close)
      })

      // Every chat currently running a turn. A chat missing from this list has no
      // live turn, which is how one stream answers for conversations the client
      // never named.
      await stream
        .writeSSE({
          data: JSON.stringify({ type: 'sync', statuses: aiService.listActiveLiveTurnStatuses() }),
        })
        .catch(close)
      await untilClosed
      unsub()
    })
  })

  // GET /api/ai/chat/live-status/:chatId — the single-chat form of the stream
  // above. SUPERSEDED: the app now subscribes to every chat at once, because one
  // connection per open conversation exhausted the renderer's 6-socket budget.
  // Kept for clients built before that change (a web build still cached in a
  // browser reaches this node through the broker) — nothing in `src/` calls it.
  // Registered before any other /chat/:param route so 'live-status' is never
  // read as an argument.
  router.get('/chat/live-status/:chatId', (c) => {
    const chatId = parseInt(c.req.param('chatId'), 10)
    return streamSSE(c, async (stream) => {
      let closed = false
      // The handler has to outlive its last write — returning ends the SSE
      // response — so it parks on this promise. Resolved from onAbort, and from a
      // failed write for the case where the client is gone but onAbort never
      // fired: either way the subscription is released rather than leaked.
      let wake: () => void = () => {}
      const untilClosed = new Promise<void>((resolve) => {
        wake = resolve
      })
      const close = (): void => {
        closed = true
        wake()
      }
      stream.onAbort(close)
      await stream
        .writeSSE({ data: JSON.stringify(aiService.getLiveTurnStatus(chatId)) })
        .catch(close)
      const unsub = aiService.subscribeLiveTurnPresence(chatId, (status) => {
        if (closed) return
        stream.writeSSE({ data: JSON.stringify(status) }).catch(close)
      })
      await untilClosed
      unsub()
    })
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

  // --- Workflows: two feeds over one event log (services/workflow/store.ts) ---

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

  // GET /api/ai/workflow/feed — SSE: every run's view, kept current. Sub-agent
  // chunks are NOT on this feed; open a run's own feed for those.
  router.get('/workflow/feed', (c) => {
    const limit = Number.parseInt(c.req.query('limit') ?? '50', 10)
    return new Response(aiService.getWorkflowFeed(Number.isFinite(limit) ? limit : 50), { headers: sseHeaders })
  })

  // GET /api/ai/workflow/run/:runId/feed?since=<eventId> — SSE for one run,
  // including its sub-agents' output. Without `since` the run's whole log is
  // replayed first, which is how a panel opened mid-run sees what already
  // happened; with it, only the missed tail is sent.
  router.get('/workflow/run/:runId/feed', (c) => {
    const sinceRaw = c.req.query('since')
    const since = sinceRaw != null ? Number.parseInt(sinceRaw, 10) : undefined
    const stream = aiService.getWorkflowRunFeed(
      c.req.param('runId'),
      since != null && Number.isFinite(since) ? since : undefined,
    )
    if (!stream) return c.json({ error: 'Workflow run not found' }, 404)
    return new Response(stream, { headers: sseHeaders })
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

  // GET /api/ai/workflow/run/:runId/agent/:index/chunks — one sub-agent's
  // recorded output, for expanding an agent on a finished run.
  router.get('/workflow/run/:runId/agent/:index/chunks', (c) => {
    const index = Number.parseInt(c.req.param('index'), 10)
    if (!Number.isFinite(index)) return c.json({ error: 'Invalid agent index' }, 400)
    return c.json(aiService.getWorkflowAgentChunks(c.req.param('runId'), index))
  })

  // POST /api/ai/cc/dynamic-set — switch model/mode/effort on a live session.
  // Path kept for compatibility; no longer Claude-only.
  router.post('/cc/dynamic-set', async (c) => {
    const { chatId, modelId, modeId, thinkingLevel } = await c.req.json<{
      chatId: number
      modelId?: string
      modeId?: string
      thinkingLevel?: string
    }>()
    const result = await aiService.handleCCDynamicSet(chatId, { modelId, modeId, thinkingLevel })
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
    return c.json({ success: result })
  })

  // POST /api/ai/inject
  router.post('/inject', async (c) => {
    const { chatId, content, turnMessageId } = await c.req.json<{
      chatId: number
      content: string
      turnMessageId?: string
    }>()
    const normalizedTurnMessageId =
      typeof turnMessageId === 'string' && turnMessageId.length > 0
        ? turnMessageId
        : undefined
    const result = await aiService.injectIntoChat(chatId, content, normalizedTurnMessageId)
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

  // GET /api/ai/claude-usage — account quota, independent of any conversation
  router.get('/claude-usage', async (c) => {
    const result = await aiService.getClaudeUsageLimits()
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
