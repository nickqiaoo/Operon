import { describe, expect, it } from 'vitest'
import { CopilotMessageMapper } from './message-mapper.js'
import type { CopilotSessionEvent } from './types.js'

/** Build a Copilot session event with only the fields the mapper reads. */
function ev(type: string, data: Record<string, unknown> = {}): CopilotSessionEvent {
  return { type, data } as unknown as CopilotSessionEvent
}

/** Run a list of events through a fresh mapper and return a compact trace. */
function trace(events: CopilotSessionEvent[]): string[] {
  const mapper = new CopilotMessageMapper()
  const out: string[] = []
  for (const event of events) {
    for (const part of mapper.map(event)) {
      switch (part.type) {
        case 'text-delta':
          out.push(`text-delta:${(part as { text: string }).text}`)
          break
        case 'reasoning-delta':
          out.push(`reasoning-delta:${(part as { text: string }).text}`)
          break
        case 'tool-call':
          out.push(`tool-call:${(part as { toolName: string }).toolName}`)
          break
        case 'tool-result':
          out.push(`tool-result:${(part as { toolName: string }).toolName}`)
          break
        case 'finish':
          out.push(`finish:${(part as { finishReason: string }).finishReason}`)
          break
        default:
          out.push(part.type)
      }
    }
  }
  return out
}

const delta = (messageId: string, deltaContent: string) =>
  ev('assistant.message_delta', { messageId, deltaContent })
const message = (messageId: string, content: string) => ev('assistant.message', { messageId, content })
const idle = () => ev('session.idle', {})

describe('CopilotMessageMapper', () => {
  it('streams message deltas incrementally and dedups the final message', () => {
    const out = trace([
      delta('m1', 'Hello'),
      delta('m1', ' world'),
      message('m1', 'Hello world'),
      idle(),
    ])
    expect(out).toEqual(['text-start', 'text-delta:Hello', 'text-delta: world', 'text-end', 'finish:stop'])
  })

  it('emits the full content when the final message arrives with no prior deltas', () => {
    const out = trace([message('m1', 'final answer'), idle()])
    expect(out).toEqual(['text-start', 'text-delta:final answer', 'text-end', 'finish:stop'])
  })

  it('gateApprovedTool drops the runtime duplicate start but still renders the completion', () => {
    // Normal mode emits the tool-call card itself via the approval handler, then
    // gates this id so the runtime's own start isn't rendered twice.
    const mapper = new CopilotMessageMapper()
    mapper.gateApprovedTool('t1', 'shell', JSON.stringify({ command: 'ls' }))
    const out: string[] = []
    const run = (e: CopilotSessionEvent) => {
      for (const part of mapper.map(e)) {
        out.push(part.type === 'tool-result' ? `tool-result:${(part as { toolName: string }).toolName}` : part.type)
      }
    }
    run(ev('tool.execution_start', { toolCallId: 't1', toolName: 'shell', arguments: { command: 'ls' } }))
    run(ev('tool.execution_complete', { toolCallId: 't1', success: true, result: 'a.txt' }))
    // Start suppressed (no tool-call / tool-input-start); completion rendered with the seeded name.
    expect(out).toEqual(['tool-result:shell'])
  })

  it('streams reasoning deltas as reasoning parts', () => {
    const out = trace([
      ev('assistant.reasoning_delta', { reasoningId: 'r1', deltaContent: 'think' }),
      ev('assistant.reasoning', { reasoningId: 'r1', content: 'think' }),
      idle(),
    ])
    expect(out).toEqual(['reasoning-start', 'reasoning-delta:think', 'reasoning-end', 'finish:stop'])
  })

  it('emits tool-call then tool-result correlated by toolCallId', () => {
    const out = trace([
      ev('tool.execution_start', { toolCallId: 'c1', toolName: 'read_file', arguments: { path: 'a.txt' } }),
      ev('tool.execution_complete', { toolCallId: 'c1', success: true, result: { content: 'file body' } }),
      idle(),
    ])
    expect(out).toEqual([
      'tool-input-start',
      'tool-call:read_file',
      'tool-result:read_file',
      'finish:stop',
    ])
  })

  it('closes an open text block before a tool call, then opens a new block after', () => {
    const out = trace([
      delta('m1', 'let me read'),
      ev('tool.execution_start', { toolCallId: 'c1', toolName: 'read_file', arguments: {} }),
      ev('tool.execution_complete', { toolCallId: 'c1', success: true, result: { content: 'x' } }),
      delta('m2', 'done'),
      message('m2', 'done'),
      idle(),
    ])
    expect(out).toEqual([
      'text-start',
      'text-delta:let me read',
      'text-end',
      'tool-input-start',
      'tool-call:read_file',
      'tool-result:read_file',
      'text-start',
      'text-delta:done',
      'text-end',
      'finish:stop',
    ])
  })

  it('surfaces a failed tool as a tool-result (no throw)', () => {
    const out = trace([
      ev('tool.execution_start', { toolCallId: 'c1', toolName: 'bash', arguments: {} }),
      ev('tool.execution_complete', { toolCallId: 'c1', success: false, error: { message: 'boom' } }),
      idle(),
    ])
    expect(out).toEqual(['tool-input-start', 'tool-call:bash', 'tool-result:bash', 'finish:stop'])
  })

  it('maps session.error to an error part + finish:error', () => {
    const out = trace([delta('m1', 'partial'), ev('session.error', { message: 'rate limited' })])
    expect(out).toEqual(['text-start', 'text-delta:partial', 'text-end', 'error', 'finish:error'])
  })

  it('emits exactly one terminal finish (idle after error is a no-op)', () => {
    const out = trace([ev('session.error', { message: 'boom' }), idle()])
    expect(out).toEqual(['error', 'finish:error'])
  })

  it('finalize() closes an open turn after a crash, and is idempotent', () => {
    const mapper = new CopilotMessageMapper()
    mapper.map(delta('m1', 'half'))
    const tail = mapper.finalize('copilot runtime exited')
    expect(tail.map((p) => p.type)).toEqual(['text-end', 'error', 'finish'])
    expect(mapper.finalize()).toEqual([])
  })

  it('suppresses runtime tool events for ask_user / exit_plan_mode (handler renders them)', () => {
    const out = trace([
      ev('tool.execution_start', { toolCallId: 'c1', toolName: 'ask_user', arguments: {} }),
      ev('tool.execution_complete', { toolCallId: 'c1', success: true, result: {} }),
      ev('tool.execution_start', { toolCallId: 'c2', toolName: 'exit_plan_mode', arguments: {} }),
      ev('tool.execution_complete', { toolCallId: 'c2', success: true, result: {} }),
      idle(),
    ])
    // Nothing rendered for the interactive tools; the session's handlers own them.
    expect(out).toEqual(['finish:stop'])
  })

  it('still renders a normal tool that follows a suppressed interactive tool', () => {
    const out = trace([
      ev('tool.execution_start', { toolCallId: 'c1', toolName: 'ask_user', arguments: {} }),
      ev('tool.execution_complete', { toolCallId: 'c1', success: true, result: {} }),
      ev('tool.execution_start', { toolCallId: 'c2', toolName: 'read_file', arguments: {} }),
      ev('tool.execution_complete', { toolCallId: 'c2', success: true, result: { content: 'x' } }),
      idle(),
    ])
    expect(out).toEqual(['tool-input-start', 'tool-call:read_file', 'tool-result:read_file', 'finish:stop'])
  })

  it('flushOpenBlocks() closes an open text block (and is a no-op when none open)', () => {
    const mapper = new CopilotMessageMapper()
    mapper.map(delta('m1', 'thinking'))
    expect(mapper.flushOpenBlocks().map((p) => p.type)).toEqual(['text-end'])
    // Already flushed — nothing left to close.
    expect(mapper.flushOpenBlocks()).toEqual([])
  })

  it('maps session.usage_info to contextUsage metadata with an exact percentUsed', () => {
    const mapper = new CopilotMessageMapper()
    const parts = mapper.map(ev('session.usage_info', { currentTokens: 40000, tokenLimit: 200000 }))
    expect(parts).toEqual([
      {
        type: 'message-metadata',
        metadata: { contextUsage: { promptTokens: 40000, contextWindow: 200000, percentUsed: 0.2 } },
      },
    ])
  })

  it('omits contextWindow/percentUsed when the runtime reports no token limit', () => {
    const mapper = new CopilotMessageMapper()
    const parts = mapper.map(ev('session.usage_info', { currentTokens: 1234, tokenLimit: 0 }))
    expect(parts).toEqual([
      { type: 'message-metadata', metadata: { contextUsage: { promptTokens: 1234 } } },
    ])
  })

  it('ignores a usage_info event with no current tokens', () => {
    const mapper = new CopilotMessageMapper()
    expect(mapper.map(ev('session.usage_info', { currentTokens: 0, tokenLimit: 200000 }))).toEqual([])
  })
})
