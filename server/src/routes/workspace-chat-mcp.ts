/**
 * Workspace chat MCP server.
 *
 * Exposes chat-only tools for internal project/channel communication. Project
 * work tracking is served by task-board-mcp.ts.
 */

import { Hono, type Context } from 'hono'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type {
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
} from '../storage/interface.js'
import { WorkspaceChatService } from '../services/agent-comm/workspace-chat-service.js'
import { serveMcpOverHono, withCodexElicitationFallback } from './mcp-http.js'

const TOOLS: Tool[] = [
  {
    name: 'send_message',
    description:
      "Post a chat message in a channel or thread. It appears in the chat under your name, every member reads it, and it stays in the history — send only what is worth reading there, never notes about your own steps. Use '#channel' for channels and '#channel:shortid' for threads. Reuse the target value from received messages to reply. To show an image (a screenshot, a chart you rendered), pass its local path in `images`; it is shown in the chat.",
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: "Where to send. Examples: '#general', '#general:abcd1234'.",
        },
        content: { type: 'string', description: 'The message content. Optional when images are attached.' },
        images: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 10,
          description:
            'Optional absolute paths of local image files (png, jpg, gif, webp, svg…) to attach, up to 10. They are copied and shown in the chat, so the people reading it see them on any device.',
        },
        force: {
          type: 'boolean',
          description:
            'Only set to true when re-sending after a send was held because new messages arrived first, and you decided your message still adds something. Leave unset otherwise.',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'check_messages',
    description:
      "Read new messages in the channel this session belongs to, without waiting. Private — no one else sees this call or its result, so there is nothing to report about it in the chat. Returns pending messages, or 'No new messages' if none, and marks them read.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_history',
    description:
      "Read message history for a channel you are a member of, or a thread in one. Use '#channel' or '#channel:shortid'. Supports pagination via before/after sequence numbers.",
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: "The target to read history from, e.g. '#general' or '#general:abcd1234'.",
        },
        limit: {
          type: 'number',
          description: 'Max number of messages to return (default 50, max 100)',
          default: 50,
        },
        before: {
          type: 'number',
          description: 'Return messages before this seq number.',
        },
        after: {
          type: 'number',
          description: 'Return messages after this seq number.',
        },
      },
      required: ['channel'],
    },
  },
  {
    name: 'open_thread',
    description:
      "Channel sessions only. Take on the work under a message in a thread: opens the thread under it (or takes over one nobody owns), posts your brief there as its first reply, and starts a thread session — yours, or the named member's — that does the work and reports back. One thread per message: if another agent already owns it, nothing is posted and the result says who, with what the thread says so far.",
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: "The msg= short id of the top-level message the thread goes under, e.g. 'a1b2c3d4'.",
        },
        brief: {
          type: 'string',
          description:
            'The first reply in the thread, readable by everyone: what is being asked and what from the channel the work needs. The thread session starts from the message, the channel messages just before it and this brief — nothing else from your session.',
        },
        agent: {
          type: 'string',
          description: 'Optional: name of the channel member who should own the thread. Defaults to you.',
        },
        channel: {
          type: 'string',
          description: "Optional: the channel, e.g. '#general'. Defaults to this session's channel.",
        },
      },
      required: ['message', 'brief'],
    },
  },
  {
    name: 'list_threads',
    description:
      "Channel sessions only. List this channel's threads, most recently active first, with their owner, status (open / waiting / done), reply count, who is running in them, and the owner's summary.",
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: "Optional: the channel, e.g. '#general'. Defaults to this session's channel." },
        limit: { type: 'number', description: 'Max threads to list (default 20).', default: 20 },
      },
    },
  },
  {
    name: 'update_thread',
    description:
      "Thread sessions only, and only the thread's owner. Report this thread's state: status 'waiting' when you need a human decision or answer, 'done' when the work is finished (with a one-line summary). channel_message also posts a short message in the main channel under your name — for the outcome the channel should hear, not for progress. A new human reply reopens the thread.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['waiting', 'done', 'open'], description: 'The thread status to report.' },
        summary: { type: 'string', description: 'One line on where the thread stands, shown under the message in the channel.' },
        channel_message: {
          type: 'string',
          description: 'Optional: a short message to also post in the main channel (e.g. the result).',
        },
      },
    },
  },
  {
    name: 'list_server',
    description:
      'List the channels you are a member of, the other agents in each (with whether they are running), and the humans. Use this to see where you can post and who you can hand work to or @mention.',
    inputSchema: { type: 'object', properties: {} },
  },
]

function buildWorkspaceChatMcpServer(bridge: WorkspaceChatService, agentId: number): Server {
  const server = new Server(
    { name: 'workspace_chat', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  // A thread session reports on its thread; a channel session opens and lists threads.
  const hidden = new Set(bridge.isThreadSession ? ['open_thread', 'list_threads'] : ['update_thread'])
  const tools = TOOLS.filter((t) => !hidden.has(t.name))
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    try {
      const text = await dispatch(name, (args ?? {}) as Record<string, unknown>, bridge, agentId)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
    }
  })

  return withCodexElicitationFallback(server)
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  bridge: WorkspaceChatService,
  agentId: number,
): Promise<string> {
  switch (name) {
    case 'send_message': {
      const target = String(args.target)
      const images = args.images
      if (images !== undefined && (!Array.isArray(images) || !images.every((p): p is string => typeof p === 'string' && p.trim() !== ''))) {
        throw new Error('images must be an array of absolute image paths.')
      }
      const result = await bridge.sendMessage({
        target,
        content: typeof args.content === 'string' ? args.content : '',
        agentId,
        images,
        force: args.force === true,
      })
      if (result.status === 'held') {
        return (
          `Not sent — ${result.pending.length} new message(s) arrived since you last checked (now marked read):\n` +
          `${result.pending.join('\n')}\n\n` +
          `Decide again with these in view. Send it (call send_message again with force=true, revised if needed) ` +
          `if the message wanted a response from you in particular, or yours adds something ` +
          `materially new (a correction, missing information, a different conclusion). If someone already said it ` +
          `for you, don't send anything. Nobody saw this draft or the hold, so don't mention either in the chat.`
        )
      }
      return `Message sent to ${target}. Message ID: ${result.messageId}`
    }

    case 'check_messages': {
      const lines = await bridge.checkMessages(agentId)
      if (lines.length === 0) return 'No new messages.'
      return lines.join('\n')
    }

    case 'read_history': {
      const result = await bridge.readHistory({
        channel: String(args.channel),
        limit: typeof args.limit === 'number' ? Math.min(args.limit, 100) : 50,
        before: typeof args.before === 'number' ? args.before : undefined,
        after: typeof args.after === 'number' ? args.after : undefined,
        agentId,
      })
      if (result.messages.length === 0) return 'No messages in this channel.'

      const channel = String(args.channel)
      let header = `## Message History for ${channel} (${result.messages.length} messages)`
      if (result.lastReadSeq > 0 && !args.before && !args.after) {
        header += `\nYour last read position: seq ${result.lastReadSeq}. Use read_history(channel="${channel}", after=${result.lastReadSeq}) to see only unread messages.`
      }

      let footer = ''
      if (result.hasMore && result.messages.length > 0) {
        if (args.after) {
          const maxSeq = result.messages[result.messages.length - 1].seq
          footer = `\n\n--- ${result.messages.length} messages shown. Use after=${maxSeq} to load more recent messages. ---`
        } else {
          const minSeq = result.messages[0].seq
          footer = `\n\n--- ${result.messages.length} messages shown. Use before=${minSeq} to load older messages. ---`
        }
      }

      return `${header}\n\n${result.messages.map((m) => m.formatted).join('\n')}${footer}`
    }

    case 'open_thread': {
      const result = await bridge.openThread({
        agentId,
        message: String(args.message ?? ''),
        brief: String(args.brief ?? ''),
        agent: typeof args.agent === 'string' ? args.agent : undefined,
        channel: typeof args.channel === 'string' ? args.channel : undefined,
      })
      if (result.status === 'taken') {
        const latest = result.latest.length > 0
          ? `\n\nLatest in the thread:\n${result.latest.map((m) => `@${m.sender}: ${m.content}`).join('\n\n')}`
          : ''
        return (
          `Not opened — ${result.target} is already owned by @${result.owner}. Nothing was posted; leave the work to them.${latest}\n\n` +
          `If you know something this misses (a constraint, a different approach, a relevant fact), pass it on with ` +
          `send_message(target="${result.target}", ...) — it reaches @${result.owner}. If you have nothing to add, do nothing: ` +
          `don't post agreement or "me too".`
        )
      }
      if (result.status === 'exists') {
        return (
          `Not opened — ${result.target} is already being worked by @${result.owner}'s thread session. Nothing was posted. ` +
          `To pass something on to it, use send_message(target="${result.target}", ...).`
        )
      }
      return (
        `Thread ${result.target} is open, owned by @${result.owner}. Your brief is its first reply, and a thread session ` +
        `is starting on it there — don't also do the work here. Follow-ups for it: send_message(target="${result.target}", ...).`
      )
    }

    case 'list_threads': {
      const lines = await bridge.listThreads({
        channel: typeof args.channel === 'string' ? args.channel : undefined,
        limit: typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 100) : 20,
      })
      if (lines.length === 0) return 'No threads in this channel.'
      return `## Threads (${lines.length})\n\n${lines.join('\n')}`
    }

    case 'update_thread': {
      const result = await bridge.updateThread({
        agentId,
        status: typeof args.status === 'string' ? args.status : undefined,
        summary: typeof args.summary === 'string' ? args.summary : undefined,
        channelMessage: typeof args.channel_message === 'string' ? args.channel_message : undefined,
      })
      return (
        `Thread ${result.target} is now ${result.status}.` +
        (result.channelMessageId ? ` Also posted in the main channel (message ID: ${result.channelMessageId}).` : '')
      )
    }

    case 'list_server': {
      const result = await bridge.listServer(agentId)

      let text = '## Your channels\n\n'
      text += 'The channels you are a member of, and who else is in each. Use `#channel-name` with send_message to post in one.\n'
      if (result.channels.length > 0) {
        for (const ch of result.channels) {
          text += ch.description ? `\n### #${ch.name} - ${ch.description}\n` : `\n### #${ch.name}\n`
          text += ch.members.length > 0
            ? ch.members.map((m) => `  - @${m.name} (${m.status})\n`).join('')
            : '  (no other agents)\n'
        }
      } else {
        text += '\n(none)\n'
      }

      text += '\n## Humans\n'
      text += result.humans.length > 0
        ? result.humans.map((h) => `  - @${h.name}\n`).join('')
        : '  (none)\n'

      return text
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

export function workspaceChatMcpRoutes(
  storage: ChannelStorageAdapter & AgentBindingStorageAdapter,
) {
  const router = new Hono()

  const handle = async (c: Context) => {
    const agentId = parseInt(c.req.header('x-agent-id') ?? c.req.query('agentId') ?? '0', 10)
    const projectId = parseInt(c.req.header('x-project-id') ?? c.req.query('projectId') ?? '0', 10)
    if (!agentId || !projectId) {
      console.warn('[workspace-chat-mcp] Missing X-Agent-Id/X-Project-Id (header or query)')
      return c.json({ error: 'agentId and projectId required (header or query)' }, 400)
    }
    const channelId = parseInt(c.req.query('channelId') ?? '', 10)
    const threadRootId = parseInt(c.req.query('threadRootId') ?? '', 10)
    console.log(
      `[workspace-chat-mcp] agent=${agentId} channel=${Number.isFinite(channelId) ? channelId : '-'}` +
        `${Number.isFinite(threadRootId) ? ` thread=${threadRootId}` : ''} ${c.req.method}`,
    )
    const bridge = new WorkspaceChatService(
      storage,
      projectId,
      Number.isFinite(channelId) ? channelId : null,
      Number.isFinite(channelId) && Number.isFinite(threadRootId) ? threadRootId : null,
    )
    return serveMcpOverHono(c, buildWorkspaceChatMcpServer(bridge, agentId))
  }

  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)

  return router
}
