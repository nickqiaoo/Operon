import type { SDKAssistantMessage, SDKPartialAssistantMessage } from '@qoder-ai/qoder-agent-sdk'

/**
 * Qoder's lazy MCP loading, seen from operon.
 *
 * Without `mcp.lazyLoad` qodercli flattens every MCP tool into the request:
 * with operon's servers plus a few plugins that was 472 tool schemas and the
 * whole 200K window (server-reported `context_usage_ratio` 1) before the first
 * message. With it the model gets three meta tools instead — `mcp_list`,
 * `mcp_get`, `mcp_call` — and calls a server tool as
 * `mcp_call { toolName: 'mcp__memory__memory_search', arguments: {...} }`.
 *
 * operon renders MCP calls by tool name (task cards, external agent cards, MCP
 * grouping), so `mcp_call` is unwrapped here into the direct call it stands for,
 * and Qoder looks like any agent that calls `mcp__<server>__<tool>` itself.
 * `allowedTools` needs nothing: qodercli matches it against the inner name.
 */

export const MCP_CALL_TOOL = 'mcp_call'

interface McpCallInput {
  toolName: string
  arguments: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The call `mcp_call` stands for, or undefined when the input is not one. */
export function parseMcpCall(toolName: string, input: unknown): McpCallInput | undefined {
  if (toolName !== MCP_CALL_TOOL || !isRecord(input) || typeof input.toolName !== 'string' || !input.toolName) {
    return undefined
  }
  return { toolName: input.toolName, arguments: isRecord(input.arguments) ? input.arguments : {} }
}

/** Back into `mcp_call`'s shape — for arguments the user edited on the approval card. */
export const wrapMcpCall = (toolName: string, args: Record<string, unknown>): McpCallInput => ({
  toolName,
  arguments: args,
})

export function unwrapAssistantMcpCalls(message: SDKAssistantMessage): SDKAssistantMessage {
  const content = message.message.content
  if (!Array.isArray(content) || !content.some((block) => block.type === 'tool_use' && block.name === MCP_CALL_TOOL)) {
    return message
  }
  return {
    ...message,
    message: {
      ...message.message,
      content: content.map((block) => {
        if (block.type !== 'tool_use' || !block.name) return block
        const call = parseMcpCall(block.name, block.input)
        return call ? { ...block, name: call.toolName, input: call.arguments } : block
      }),
    },
  }
}

type StreamEvent = SDKPartialAssistantMessage['event']

/**
 * The streaming half. An `mcp_call` block names its target only inside its
 * input JSON, which arrives in fragments, so the block is held back until it
 * closes and then replayed as one block for the real tool. Every other event
 * passes straight through. (Qoder types stream events loosely — every field
 * optional — hence the explicit checks.)
 */
export class McpCallStreamUnwrapper {
  /** Open `mcp_call` blocks, by sub-agent and content index. */
  private readonly pending = new Map<string, { start: StreamEvent; index: number; json: string }>()

  transform(message: SDKPartialAssistantMessage): SDKPartialAssistantMessage[] {
    const event = message.event
    const index = event.index
    if (typeof index !== 'number') return [message]
    const key = `${message.parent_tool_use_id ?? ''}:${index}`

    switch (event.type) {
      case 'content_block_start':
        if (event.content_block?.type === 'tool_use' && event.content_block.name === MCP_CALL_TOOL) {
          this.pending.set(key, { start: event, index, json: '' })
          return []
        }
        return [message]
      case 'content_block_delta': {
        const held = this.pending.get(key)
        if (!held) return [message]
        const delta = event.delta
        if (isRecord(delta) && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          held.json += delta.partial_json
        }
        return []
      }
      case 'content_block_stop': {
        const held = this.pending.get(key)
        if (!held) return [message]
        this.pending.delete(key)
        return this.replay(message, held)
      }
      default:
        return [message]
    }
  }

  private replay(
    stop: SDKPartialAssistantMessage,
    held: { start: StreamEvent; index: number; json: string },
  ): SDKPartialAssistantMessage[] {
    const block = held.start.content_block
    if (!block) return [stop]
    let input: unknown
    try {
      input = JSON.parse(held.json)
    } catch {
      input = undefined
    }
    const call = parseMcpCall(MCP_CALL_TOOL, input)
    // Unparseable: replay the original `mcp_call` block untouched.
    const name = call?.toolName ?? MCP_CALL_TOOL
    const partialJson = call ? JSON.stringify(call.arguments) : held.json
    const at = (event: StreamEvent): SDKPartialAssistantMessage => ({ ...stop, event })
    return [
      at({ ...held.start, content_block: { ...block, name, input: {} } }),
      at({ type: 'content_block_delta', index: held.index, delta: { type: 'input_json_delta', partial_json: partialJson } }),
      stop,
    ]
  }
}
