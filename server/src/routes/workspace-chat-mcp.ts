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
      "Send a message to a workspace channel or thread. Use '#channel' for channels and '#channel:shortid' for threads. Reuse the target value from received messages to reply.",
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: "Where to send. Examples: '#general', '#general:abcd1234'.",
        },
        content: { type: 'string', description: 'The message content' },
        attachment_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional attachment IDs from upload_file to include with the message',
        },
      },
      required: ['target', 'content'],
    },
  },
  {
    name: 'check_messages',
    description:
      "Check for new workspace messages without waiting. Returns immediately with pending messages, or 'No new messages' if none. Advances your read cursor.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_history',
    description:
      "Read message history for a workspace channel or thread. Use '#channel' or '#channel:shortid'. Supports pagination via before/after sequence numbers.",
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
    name: 'list_server',
    description:
      'List all workspace channels, agents, and humans visible to you. Use this to discover where you can message.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'upload_file',
    description:
      "Upload an image file to attach to a message. Returns an attachment ID that you can pass to send_message's attachment_ids parameter.",
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the image file on your local filesystem',
        },
        channel: {
          type: 'string',
          description: "The channel target where this file will be used, e.g. '#general'.",
        },
      },
      required: ['file_path', 'channel'],
    },
  },
  {
    name: 'view_file',
    description:
      "Download an attached image by its attachment ID and save it locally so you can view it.",
    inputSchema: {
      type: 'object',
      properties: {
        attachment_id: {
          type: 'string',
          description: "The attachment UUID shown in the message.",
        },
      },
      required: ['attachment_id'],
    },
  },
]

function buildWorkspaceChatMcpServer(bridge: WorkspaceChatService, agentId: number): Server {
  const server = new Server(
    { name: 'workspace_chat', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

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
      const result = await bridge.sendMessage({
        target,
        content: String(args.content),
        agentId,
        attachmentIds: Array.isArray(args.attachment_ids)
          ? args.attachment_ids.filter((id): id is string => typeof id === 'string')
          : undefined,
      })
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

    case 'list_server': {
      const result = await bridge.listServer()

      let text = '## Workspace\n\n'
      text += '### Channels\n'
      text += 'Use `#channel-name` with send_message to post in a channel.\n'
      if (result.channels.length > 0) {
        for (const ch of result.channels) {
          const status = ch.joined ? 'joined' : 'not joined'
          text += ch.description
            ? `  - #${ch.name} [${status}] - ${ch.description}\n`
            : `  - #${ch.name} [${status}]\n`
        }
      } else {
        text += '  (none)\n'
      }

      text += '\n### Agents\n'
      if (result.agents.length > 0) {
        for (const agent of result.agents) {
          text += `  - @${agent.name} (${agent.status})\n`
        }
      } else {
        text += '  (none)\n'
      }

      text += '\n### Humans\n'
      if (result.humans.length > 0) {
        for (const human of result.humans) {
          text += `  - @${human.name}\n`
        }
      } else {
        text += '  (none)\n'
      }

      return text
    }

    case 'upload_file': {
      const result = await bridge.uploadFile(String(args.file_path), String(args.channel))
      return `File uploaded: ${result.filename} (${(result.sizeBytes / 1024).toFixed(1)}KB)\nAttachment ID: ${result.attachmentId}`
    }

    case 'view_file': {
      const result = await bridge.viewFile(String(args.attachment_id))
      return `Downloaded to: ${result.filePath}`
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
    console.log(`[workspace-chat-mcp] agent=${agentId} ${c.req.method}`)
    const bridge = new WorkspaceChatService(storage, projectId)
    return serveMcpOverHono(c, buildWorkspaceChatMcpServer(bridge, agentId))
  }

  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)

  return router
}
