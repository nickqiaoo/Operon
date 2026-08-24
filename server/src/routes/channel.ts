import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
  ProjectStorageAdapter,
} from '../storage/interface.js'
import { emitChannelEvent, onChannelEvent, onProjectEvent } from '../services/channel-bus.js'
import { routeMessageToAgents } from '../services/channel/agent-orchestrator.js'
import { resetBinding } from '../services/channel/binding-reset.js'
import { handleChannelSlashCommand } from '../services/channel/channel-commands.js'
import { abortChat } from '../services/ai.js'
import type {
  CreateAgentInput,
  CreateChannelInput,
  CreateMessageInput,
  UpdateAgentInput,
} from '../types/channel.js'

type ChannelStorage = ChannelStorageAdapter
  & Pick<ProjectStorageAdapter, 'getProject'>
  & AgentBindingStorageAdapter

export function agentRoutes(storage: ChannelStorage) {
  const router = new Hono()

  // Hidden agents (e.g. the implicit `Workspace Assistant` spec author for
  // chat-sourced SDD tasks) are excluded from this list — it feeds every
  // user-facing agent picker (channel members, dispatch assignee, @mention).
  // Server-side callers that need them resolve by id via getAgent().
  router.get('/', (c) => c.json({ agents: storage.listAgents().filter((a) => !a.hidden) }))

  router.post('/', async (c) => {
    const input = await c.req.json<CreateAgentInput>()
    const agent = storage.createAgent(input)
    return c.json({ agent })
  })

  router.get('/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const agent = storage.getAgent(id)
    if (!agent) return c.json({ error: 'Not found' }, 404)
    return c.json({ agent })
  })

  router.put('/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const raw = (await c.req.json<Record<string, unknown>>()) ?? {}
    // provider is locked at create-time. Reject any attempt to change it so
    // we never orphan native session state (Claude SDK / Codex / Kimi).
    if ('provider' in raw) {
      return c.json(
        { error: 'provider cannot be changed; delete and recreate the agent to switch provider' },
        400,
      )
    }
    storage.updateAgent(id, raw as UpdateAgentInput)
    return c.json({ agent: storage.getAgent(id) })
  })

  router.delete('/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    storage.deleteAgent(id)
    return c.json({ success: true })
  })

  // Stop all active app bindings for the agent in a project
  router.post('/:id/stop', async (c) => {
    const agentId = parseInt(c.req.param('id'), 10)
    const projectId = parseInt(c.req.query('projectId') ?? '0', 10)
    if (!projectId) return c.json({ error: 'projectId required' }, 400)
    const bindings = storage.listBindings({
      scopeKind: 'app',
      agentId,
      projectId,
      status: 'active',
    })
    let stoppedAny = false
    for (const b of bindings) {
      if (b.activeChatId == null) continue
      if (abortChat(b.activeChatId)) {
        storage.updateBinding(b.id, { status: 'idle' })
        stoppedAny = true
      }
    }
    return c.json({ success: stoppedAny })
  })

  // Reset all of the agent's app bindings in a project (mark offline, clear chats, dispose runtime)
  router.post('/:id/reset', async (c) => {
    const agentId = parseInt(c.req.param('id'), 10)
    const projectId = parseInt(c.req.query('projectId') ?? '0', 10)
    if (!projectId) return c.json({ error: 'projectId required' }, 400)
    const bindings = storage.listBindings({ scopeKind: 'app', agentId, projectId })
    for (const b of bindings) {
      await resetBinding(storage, b)
    }
    return c.json({ success: true })
  })

  // List all bindings (across scope kinds) for an agent
  router.get('/:id/sessions', (c) => {
    const agentId = parseInt(c.req.param('id'), 10)
    return c.json({ sessions: storage.listBindings({ agentId }) })
  })

  return router
}

/**
 * Per-binding reset — abort + destroy session + clear chatId, mark offline.
 * Works across all scope kinds (app, slack, telegram, linear) because the
 * unified `resetBinding` doesn't depend on scope-specific state.
 */
export function agentBindingRoutes(storage: ChannelStorage) {
  const router = new Hono()

  router.post('/:id/reset', async (c) => {
    const bindingId = parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(bindingId)) return c.json({ error: 'invalid binding id' }, 400)
    const binding = storage.getBinding(bindingId)
    if (!binding) return c.json({ error: 'binding not found' }, 404)
    await resetBinding(storage, binding)
    return c.json({ success: true })
  })

  return router
}

export function channelRoutes(storage: ChannelStorage) {
  const router = new Hono()

  // ---- Agent sessions (before /:id/* to avoid wildcard conflict) ----

  router.get('/agents/sessions', (c) => {
    const projectId = parseInt(c.req.query('projectId') ?? '0', 10)
    if (!projectId) return c.json({ error: 'projectId required' }, 400)
    return c.json({ sessions: storage.listBindings({ scopeKind: 'app', projectId }) })
  })

  // ---- Channels CRUD ----

  router.get('/', (c) => {
    const projectId = parseInt(c.req.query('projectId') ?? '0', 10)
    if (!projectId) return c.json({ error: 'projectId required' }, 400)
    return c.json({ channels: storage.listChannels(projectId) })
  })

  router.post('/', async (c) => {
    const input = await c.req.json<CreateChannelInput>()
    // Channel names must be unique within a project (see migration 0032):
    // agent routing resolves #name to a single channel, so a duplicate name
    // would shadow the newer channel. Reject early with a clear 409 instead of
    // letting the UNIQUE index throw a raw SQLite error.
    const duplicate = storage.listChannels(input.projectId).some((ch) => ch.name === input.name)
    if (duplicate) {
      return c.json({ error: `A channel named "${input.name}" already exists in this project.` }, 409)
    }
    const channel = storage.createChannel(input)
    return c.json({ channel })
  })

  router.delete('/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    // Deleting a channel orphans every agent's per-channel app binding (no FK
    // cascade — foreign keys are banned in this project). Left behind they
    // linger forever in the agent session list showing the dead channel. Mirror
    // the member-removal path: tear down any live runtime, then drop the binding
    // rows. deleteChannel sweeps the channel's other dependents (members,
    // messages, read cursors).
    for (const binding of storage.listBindingsForScope('app', String(id))) {
      await resetBinding(storage, binding)
      storage.deleteBinding(binding.id)
    }
    storage.deleteChannel(id)
    return c.json({ success: true })
  })

  // ---- Members ----

  router.get('/:id/members', (c) => {
    const channelId = parseInt(c.req.param('id'), 10)
    return c.json({ members: storage.listMembers(channelId) })
  })

  router.post('/:id/members', async (c) => {
    const channelId = parseInt(c.req.param('id'), 10)
    const { agentId } = await c.req.json<{ agentId: number }>()
    const member = storage.addMember(channelId, agentId)
    // Initialize read cursor at 0
    storage.upsertCursor(agentId, 'app', String(channelId), 0)
    // Emit system join message
    const joinMsg = storage.createMessage({
      channelId,
      senderType: 'system',
      senderName: 'system',
      content: `${storage.getAgent(agentId)?.name ?? 'Agent'} joined the channel`,
    })
    emitChannelEvent(channelId, { type: 'channel_message', data: joinMsg })
    return c.json({ member })
  })

  router.delete('/:id/members/:agentId', async (c) => {
    const channelId = parseInt(c.req.param('id'), 10)
    const agentId = parseInt(c.req.param('agentId'), 10)
    storage.removeMember(channelId, agentId)
    // Removing the agent from the channel orphans its per-channel app binding.
    // Left in place it lingers in the agent's session list as a stale idle/offline
    // row forever (bindings otherwise have no lifecycle that deletes them). Tear
    // down any live runtime first, then drop the row so the list reflects reality.
    const binding = storage.getBindingByScope('app', String(channelId), agentId)
    if (binding) {
      await resetBinding(storage, binding)
      storage.deleteBinding(binding.id)
    }
    return c.json({ success: true })
  })

  // ---- Messages ----

  router.get('/:id/messages', (c) => {
    const channelId = parseInt(c.req.param('id'), 10)
    const beforeStr = c.req.query('before')
    const limitStr = c.req.query('limit')
    const before = beforeStr ? parseInt(beforeStr, 10) : undefined
    const limit = limitStr ? parseInt(limitStr, 10) : undefined
    const result = storage.listMessages(channelId, { before, limit })
    return c.json(result)
  })

  router.post('/:id/messages', async (c) => {
    const channelId = parseInt(c.req.param('id'), 10)
    const body = await c.req.json<Omit<CreateMessageInput, 'channelId'>>()
    const message = storage.createMessage({ ...body, channelId })
    console.log(`[Channel] Message created: id=${message.id} channel=${channelId} sender=${message.senderName} type=${message.senderType}`)
    emitChannelEvent(channelId, { type: 'channel_message', data: message })
    // Intercept human slash commands (/reset) before routing — parity with IM.
    // When handled, the command is NOT forwarded to the model.
    const handled = await handleChannelSlashCommand(storage, channelId, message, (m) =>
      emitChannelEvent(channelId, { type: 'channel_message', data: m }),
    )
    if (!handled) {
      // Route to agents asynchronously — do not block the HTTP response
      routeMessageToAgents(channelId, message).catch((err) => {
        console.error('[Channel] routeMessageToAgents error:', err)
      })
    }
    return c.json({ message })
  })

  // ---- Thread replies ----

  router.get('/:id/messages/:mid/replies', (c) => {
    const mid = parseInt(c.req.param('mid'), 10)
    return c.json({ replies: storage.listThreadReplies(mid) })
  })

  router.post('/:id/messages/:mid/replies', async (c) => {
    const channelId = parseInt(c.req.param('id'), 10)
    const threadRootId = parseInt(c.req.param('mid'), 10)
    const body = await c.req.json<Omit<CreateMessageInput, 'channelId' | 'threadRootId'>>()
    const message = storage.createMessage({ ...body, channelId, threadRootId })
    emitChannelEvent(channelId, { type: 'channel_message', data: message })
    routeMessageToAgents(channelId, message).catch((err) => {
      console.error('[Channel] routeMessageToAgents error:', err)
    })
    return c.json({ message })
  })

  // ---- SSE stream ----

  router.get('/:id/stream', (c) => {
    const channelId = parseInt(c.req.param('id'), 10)
    return streamSSE(c, async (stream) => {
      let closed = false
      stream.onAbort(() => {
        closed = true
      })

      const unsubChannel = onChannelEvent(channelId, (event) => {
        if (closed) return
        stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {})
      })

      // Also forward agent_status events from the channel's project
      const channel = storage.getChannel(channelId)
      const unsubProject = channel
        ? onProjectEvent(channel.projectId, (event) => {
            if (closed) return
            stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {})
          })
        : undefined

      while (!closed) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      }

      unsubChannel()
      unsubProject?.()
    })
  })

  return router
}
