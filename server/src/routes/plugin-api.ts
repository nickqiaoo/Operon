import { Hono } from 'hono'
import * as aiService from '../services/ai.js'
import type { PermissionOutcome } from '../services/ai.js'
import type { ProjectStorageAdapter } from '../storage/interface.js'

/**
 * Plugin API routes for external integrations (e.g. OpenClaw).
 *
 * These endpoints expose xui's AI capabilities over HTTP so that
 * external systems can leverage its adapters (Claude Code, Gemini, etc.)
 * without embedding the adapter logic.
 */
export function pluginApiRoutes(storage: ProjectStorageAdapter) {
  const router = new Hono()

  /**
   * GET /api/plugin/providers
   * List available adapters and their models.
   */
  router.get('/providers', async (c) => {
    const providers = aiService.getProviders()
    const detailed = await Promise.all(
      providers.map(async (p) => {
        try {
          const models = await aiService.getProviderModels(p.id)
          return { ...p, models: models.models, configOptions: models.configOptions }
        } catch {
          return { ...p, models: [], configOptions: [] }
        }
      }),
    )
    return c.json({ providers: detailed })
  })

  /**
   * GET /api/plugin/workspaces
   * List all projects and their workspaces.
   */
  router.get('/workspaces', (c) => {
    const projects = storage.listProjects()
    const result = projects.map((p) => ({
      ...p,
      workspaces: storage.listWorkspaces(p.id),
    }))
    return c.json({ projects: result })
  })

  /**
   * POST /api/plugin/chat
   * Start a streaming chat session. Returns a standard AI SDK UIMessageStream.
   * Response header X-Chat-Id carries the server-assigned chat ID for session reuse.
   *
   * Body: { providerId, modelId?, message, chatId?, workspaceId }
   */
  router.post('/chat', async (c) => {
    const body = await c.req.json<{
      providerId?: string
      modelId?: string
      message: string
      chatId?: number
      workspaceId: number
    }>()

    const userMessage = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: body.message,
      parts: [{ type: 'text' as const, text: body.message }],
      createdAt: new Date(),
    }

    return aiService.handleChat({
      chatId: body.chatId,
      messages: [userMessage],
      providerId: body.providerId ?? 'claude-code',
      modelId: body.modelId,
      workspaceId: body.workspaceId,
      skipSnapshot: true,
    }, c.req.raw.signal)
  })

  /**
   * POST /api/plugin/sessions/:chatId/permissions/:approvalId
   * Resolve a pending tool approval request.
   *
   * Body: { type: "allow" | "deny" | "allowAlways" }
   */
  router.post('/sessions/:chatId/permissions/:approvalId', async (c) => {
    const chatId = parseInt(c.req.param('chatId'), 10)
    const approvalId = c.req.param('approvalId')
    const { type: outcome } = await c.req.json<{ type: PermissionOutcome }>()

    const result = aiService.handlePermissionResponse(approvalId, outcome, chatId)
    return c.json({ success: result })
  })

  return router
}

