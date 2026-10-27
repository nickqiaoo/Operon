import { describe, expect, it } from 'vitest'
import type { SDKAssistantMessage, SDKPartialAssistantMessage } from '@qoder-ai/qoder-agent-sdk'
import { McpCallStreamUnwrapper, parseMcpCall, unwrapAssistantMcpCalls, wrapMcpCall } from './mcp-call.js'

const streamEvent = (event: SDKPartialAssistantMessage['event'], parent: string | null = null): SDKPartialAssistantMessage =>
  ({ type: 'stream_event', event, parent_tool_use_id: parent, uuid: 'u', session_id: 's' }) as SDKPartialAssistantMessage

const start = (index: number, name: string) =>
  streamEvent({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call_${index}`, name, input: {} } })
const delta = (index: number, partial_json: string) =>
  streamEvent({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })
const stop = (index: number) => streamEvent({ type: 'content_block_stop', index })

describe('parseMcpCall', () => {
  it('reads the inner tool and its arguments', () => {
    expect(parseMcpCall('mcp_call', { toolName: 'mcp__memory__memory_search', arguments: { query: 'x' } })).toEqual({
      toolName: 'mcp__memory__memory_search',
      arguments: { query: 'x' },
    })
  })

  it('ignores other tools and malformed input', () => {
    expect(parseMcpCall('Bash', { toolName: 'mcp__a__b' })).toBeUndefined()
    expect(parseMcpCall('mcp_call', { arguments: {} })).toBeUndefined()
    expect(parseMcpCall('mcp_call', 'nope')).toBeUndefined()
  })

  it('round-trips through wrapMcpCall', () => {
    const wrapped = wrapMcpCall('mcp__a__b', { k: 1 })
    expect(parseMcpCall('mcp_call', wrapped)).toEqual({ toolName: 'mcp__a__b', arguments: { k: 1 } })
  })
})

describe('McpCallStreamUnwrapper', () => {
  it('holds an mcp_call block and replays it as the real tool once it closes', () => {
    const unwrapper = new McpCallStreamUnwrapper()
    expect(unwrapper.transform(start(1, 'mcp_call'))).toEqual([])
    expect(unwrapper.transform(delta(1, '{"arguments":{"query":'))).toEqual([])
    expect(unwrapper.transform(delta(1, '"operon"},"toolName":"mcp__memory__memory_search"}'))).toEqual([])

    const replayed = unwrapper.transform(stop(1)).map((m) => m.event)
    expect(replayed).toEqual([
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'mcp__memory__memory_search', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"operon"}' } },
      { type: 'content_block_stop', index: 1 },
    ])
  })

  it('passes every other block through untouched', () => {
    const unwrapper = new McpCallStreamUnwrapper()
    const events = [start(0, 'Bash'), delta(0, '{"command":"ls"}'), stop(0)]
    for (const event of events) expect(unwrapper.transform(event)).toEqual([event])
  })

  it('replays an unparseable mcp_call as it was', () => {
    const unwrapper = new McpCallStreamUnwrapper()
    unwrapper.transform(start(2, 'mcp_call'))
    unwrapper.transform(delta(2, '{"toolName":'))
    const replayed = unwrapper.transform(stop(2)).map((m) => m.event)
    expect(replayed[0]?.content_block?.name).toBe('mcp_call')
    expect(replayed[1]?.delta).toEqual({ type: 'input_json_delta', partial_json: '{"toolName":' })
  })

  it('keeps a sub-agent block apart from the main one at the same index', () => {
    const unwrapper = new McpCallStreamUnwrapper()
    unwrapper.transform(start(0, 'mcp_call'))
    const subagentText = streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'call_parent')
    expect(unwrapper.transform(subagentText)).toEqual([subagentText])
  })
})

describe('unwrapAssistantMcpCalls', () => {
  it('rewrites mcp_call blocks in a full assistant message', () => {
    const message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'looking' },
          { type: 'tool_use', id: 'call_1', name: 'mcp_call', input: { toolName: 'mcp__taskboard__list_project_tasks', arguments: { limit: 5 } } },
        ],
      },
      parent_tool_use_id: null,
    } as unknown as SDKAssistantMessage
    const content = unwrapAssistantMcpCalls(message).message.content
    expect(content[1]).toEqual({ type: 'tool_use', id: 'call_1', name: 'mcp__taskboard__list_project_tasks', input: { limit: 5 } })
    expect(content[0]).toEqual({ type: 'text', text: 'looking' })
  })
})
