import { Hono } from 'hono'
import { ChatHistoryService } from '../services/chat-history.js'
import type { ChatStorageAdapter } from '../storage/interface.js'
import type { ChatType } from '../types/chat.js'

export function chatHistoryRoutes(storage: ChatStorageAdapter) {
  const router = new Hono()
  const service = new ChatHistoryService(storage)

  // GET /api/chat-history - list chats
  router.get('/', (c) => {
    const workspaceIdStr = c.req.query('workspaceId')
    const workspaceId = workspaceIdStr ? parseInt(workspaceIdStr, 10) : undefined
    const tp = c.req.query('tp')
    const limitStr = c.req.query('limit')
    const offsetStr = c.req.query('offset')
    const limit = limitStr ? parseInt(limitStr, 10) : undefined
    const offset = offsetStr ? parseInt(offsetStr, 10) : undefined
    const result = service.listChats(workspaceId, tp, {
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
    })
    return c.json(result.map(({ sessionId: _sessionId, ...entry }) => entry))
  })

  // GET /api/chat-history/:chatId - get chat (full or paginated)
  router.get('/:chatId', (c) => {
    const chatId = parseInt(c.req.param('chatId'), 10)
    const limitStr = c.req.query('limit')
    const beforeStr = c.req.query('before')

    // Paginated mode: return a page of messages
    if (limitStr) {
      const limit = parseInt(limitStr, 10)
      const before = beforeStr ? parseInt(beforeStr, 10) : undefined
      const result = storage.getChatMessages(chatId, { before, limit })
      if (!result) return c.json({ messages: [], total: 0, hasMore: false })
      // Include chat meta for the first page
      const meta = storage.getChatMeta(chatId)
      return c.json({
        messages: result.messages,
        total: result.total,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        model: meta?.model,
        providerId: meta?.providerId,
        thinkingLevel: meta?.thinkingLevel,
        revision: meta?.revision ?? 0,
        // When the last message landed. The client times prompt-cache expiry
        // from this so a conversation reopened from history knows it went cold
        // while it was closed.
        updatedAt: meta?.updatedAt,
      })
    }

    // Full mode: return all messages (for AI context, backward compat)
    const result = service.getChat(chatId)
    const { sessionId: _sessionId, ...payload } = result
    return c.json(payload)
  })

  // POST /api/chat-history - create new chat
  router.post('/', async (c) => {
    const {
      baseRevision,
      replaceFrom,
      tailMessages,
      tp,
      workspaceId,
      model,
      providerId,
      thinkingLevel,
    } = await c.req.json<{
      baseRevision: number
      replaceFrom: number
      tailMessages: unknown[]
      tp?: string
      workspaceId?: number
      model?: string
      providerId?: string
      thinkingLevel?: string
    }>()

    if (!Number.isInteger(baseRevision) || baseRevision < 0) {
      return c.json({ success: false, error: 'baseRevision must be a non-negative integer' }, 400)
    }
    if (!Number.isInteger(replaceFrom) || replaceFrom < 0) {
      return c.json({ success: false, error: 'replaceFrom must be a non-negative integer' }, 400)
    }
    if (!Array.isArray(tailMessages)) {
      return c.json({ success: false, error: 'tailMessages must be an array' }, 400)
    }

    const result = service.patchChat(
      null,
      baseRevision,
      replaceFrom,
      tailMessages,
      (tp as ChatType) ?? 'chat',
      workspaceId,
      model,
      providerId,
      undefined,
      thinkingLevel
    )

    return c.json(result)
  })

  // POST /api/chat-history/side - open a side chat branched off `parentChatId`
  //
  // The row is created empty and up front, before the user has typed anything,
  // so the tab has an id to render against immediately. The provider session is
  // not forked here — that happens on the first turn, in chat-flow's
  // `resolveForkSource`, because forking a thread nobody talks to would burn a
  // thread for every side chat the user opens and abandons.
  router.post('/side', async (c) => {
    const { parentChatId, title } = await c.req.json<{ parentChatId?: number; title?: string }>()
    if (!Number.isInteger(parentChatId) || (parentChatId as number) <= 0) {
      return c.json({ success: false, error: 'parentChatId must be a positive integer' }, 400)
    }
    const parent = storage.getChatMeta(parentChatId as number)
    if (!parent) {
      return c.json({ success: false, error: 'Parent chat not found' }, 404)
    }
    if (parent.tp === 'side') {
      return c.json({ success: false, error: 'Cannot open a side chat from a side chat' }, 400)
    }

    const result = storage.patchChatEntry(null, {
      baseRevision: 0,
      replaceFrom: 0,
      tailMessages: [],
      tp: 'side',
      title: title?.trim() || 'Side chat',
      workspaceId: parent.workspaceId,
      model: parent.model,
      providerId: parent.providerId,
      thinkingLevel: parent.thinkingLevel,
      updatedAt: Date.now(),
      metadata: {
        parentChatId: parentChatId as number,
        forkedAtMessageIndex: storage.getChatMessages(parentChatId as number, { limit: 0 })?.total ?? 0,
        // The side chat inherits the parent's runtime selections: a fork that ran
        // on a different model would not share the parent's cached prefix.
        ...(parent.metadata?.chatRuntimeOptions
          ? { chatRuntimeOptions: parent.metadata.chatRuntimeOptions }
          : {}),
      },
    })

    return c.json(result)
  })

  // PATCH /api/chat-history/:chatId - update existing chat
  router.patch('/:chatId', async (c) => {
    const chatId = parseInt(c.req.param('chatId'), 10)
    const {
      baseRevision,
      replaceFrom,
      tailMessages,
      workspaceId,
      model,
      providerId,
      thinkingLevel,
    } = await c.req.json<{
      baseRevision: number
      replaceFrom: number
      tailMessages: unknown[]
      workspaceId?: number
      model?: string
      providerId?: string
      thinkingLevel?: string
    }>()

    if (!Number.isInteger(baseRevision) || baseRevision < 0) {
      return c.json({ success: false, error: 'baseRevision must be a non-negative integer' }, 400)
    }
    if (!Number.isInteger(replaceFrom) || replaceFrom < 0) {
      return c.json({ success: false, error: 'replaceFrom must be a non-negative integer' }, 400)
    }
    if (!Array.isArray(tailMessages)) {
      return c.json({ success: false, error: 'tailMessages must be an array' }, 400)
    }

    const result = service.patchChat(
      chatId,
      baseRevision,
      replaceFrom,
      tailMessages,
      undefined,
      workspaceId,
      model,
      providerId,
      undefined,
      thinkingLevel
    )

    return c.json(result)
  })

  // DELETE /api/chat-history/:chatId - delete chat
  router.delete('/:chatId', (c) => {
    const chatId = parseInt(c.req.param('chatId'), 10)
    const result = service.clearChat(chatId)
    return c.json({ success: result })
  })

  return router
}
