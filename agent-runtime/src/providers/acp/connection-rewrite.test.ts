import { describe, expect, it } from 'vitest'
import { rewriteLine } from './connection.js'

function update(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: fields } })}\n`
}

describe('rewriteLine', () => {
  it('wraps a string rawOutput so the SDK accepts the update (antigravity)', () => {
    const line = update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'failed', rawOutput: 'Tool execution failed' })
    const out = rewriteLine(line)
    expect(out?.endsWith('\n')).toBe(true)
    expect(JSON.parse(out ?? '').params.update.rawOutput).toEqual({ output: 'Tool execution failed' })
  })

  it('leaves an object rawOutput untouched', () => {
    const line = update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed', rawOutput: { output: 'ok' } })
    expect(rewriteLine(line)).toBe(line)
  })

  it('drops proprietary session updates', () => {
    expect(rewriteLine(update({ sessionUpdate: 'session_info_update', title: 'x' }))).toBeNull()
  })
})
