import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OPENCODE_CALLER_ARG, OPENCODE_CALLER_PLUGIN_SOURCE } from './caller-identity.js'
import type { NestedResult, NestedResultSource } from './code-mode.js'
import { convertEventToStreamParts, createStreamState, type OpencodeEvent } from './event-stream.js'
import type { RuntimeStreamPart } from '../../types.js'

type NestedEntry = { tool: string; status: 'running' | 'completed' | 'error'; input?: Record<string, unknown> }

const executePart = (status: 'running' | 'completed' | 'error', toolCalls: NestedEntry[]): OpencodeEvent => {
  const input = { code: 'return await tools.example.read({})' }
  const time = status === 'running' ? { start: 1 } : { start: 1, end: 2 }
  const state = status === 'running'
    ? { status, input, time, metadata: { toolCalls } }
    : status === 'completed'
      ? { status, input, output: 'OK', title: 'execute', time, metadata: { toolCalls } }
      : { status, input, error: 'boom', time, metadata: { toolCalls } }
  return {
    type: 'message.part.updated',
    properties: {
      part: { id: 'execute-part', messageID: 'message-1', sessionID: 'session-1', type: 'tool', callID: 'execute-1', tool: 'execute', state },
    },
  }
}

const permission = (id: string, tool: string): OpencodeEvent => ({
  type: 'permission.asked',
  properties: {
    id, sessionID: 'session-1', permission: tool, patterns: ['*'], always: ['*'],
    metadata: {}, tool: { messageID: 'message-1', callID: 'execute-1' },
  },
})

function memoryResults(records: NestedResult[]): NestedResultSource & { forgotten: string[] } {
  const forgotten: string[] = []
  return { read: () => records, forget: (id) => void forgotten.push(id), forgotten }
}

const ofType = <T extends RuntimeStreamPart['type']>(parts: RuntimeStreamPart[], type: T) =>
  parts.filter((part): part is Extract<RuntimeStreamPart, { type: T }> => part.type === type)

describe('OpenCode Code Mode stream', () => {
  it('surfaces each nested call as its own tool part, under its real tool key', () => {
    const state = createStreamState({ nestedResults: memoryResults([]) })
    const parts = convertEventToStreamParts(executePart('running', [
      { tool: 'external_agent.external_agent_run', status: 'running', input: { prompt: 'fix it', [OPENCODE_CALLER_ARG]: 'ses_root' } },
    ]), state)
    const calls = ofType(parts, 'tool-call')
    expect(calls.map((call) => call.toolCallId)).toEqual(['execute-1', 'execute-1/1'])
    expect(calls[1]).toMatchObject({
      toolName: 'external_agent_external_agent_run',
      input: JSON.stringify({ prompt: 'fix it' }),
      providerExecuted: true,
      dynamic: true,
      providerMetadata: { opencode: { programToolCallId: 'execute-1' } },
    })
    // The program's own card is complete before the calls it makes appear.
    expect(parts.findIndex((part) => part.type === 'tool-input-end')).toBeLessThan(parts.indexOf(calls[1]!))
    // A repeated update adds nothing.
    expect(ofType(convertEventToStreamParts(executePart('running', [
      { tool: 'external_agent.external_agent_run', status: 'running', input: { prompt: 'fix it' } },
    ]), state), 'tool-call')).toEqual([])
  })

  it('gives a finished nested call the output the plugin recorded, matched by tool and input', () => {
    const results = memoryResults([
      { tool: 'schedule_schedule_create', args: { name: 'b', [OPENCODE_CALLER_ARG]: 'ses' }, output: '{"task":{"id":2}}' },
      { tool: 'schedule_schedule_create', args: { name: 'a' }, output: '{"task":{"id":1}}' },
    ])
    const state = createStreamState({ nestedResults: results })
    const entries: NestedEntry[] = [
      { tool: 'schedule.schedule_create', status: 'completed', input: { name: 'a' } },
      { tool: 'schedule.schedule_create', status: 'error', input: { name: 'b' } },
    ]
    const parts = convertEventToStreamParts(executePart('running', entries), state)
    expect(ofType(parts, 'tool-result')).toEqual([expect.objectContaining({ toolCallId: 'execute-1/1', output: '{"task":{"id":1}}' })])
    expect(ofType(parts, 'tool-error').map((part) => part.toolCallId)).toEqual(['execute-1/2'])

    const done = convertEventToStreamParts(executePart('completed', entries), state)
    expect(ofType(done, 'tool-result').map((part) => part.toolCallId)).toEqual(['execute-1'])
    expect(results.forgotten).toEqual(['execute-1'])
  })

  it('hangs each approval on the nested call that asked, in the order the calls started', () => {
    const state = createStreamState({ nestedResults: memoryResults([]) })
    const parts = convertEventToStreamParts(executePart('running', [
      { tool: 'example.read', status: 'running', input: { path: 'a' } },
      { tool: 'example.read', status: 'running', input: { path: 'b' } },
    ]), state)
    for (const id of ['approval-1', 'approval-2']) parts.push(...convertEventToStreamParts(permission(id, 'example_read'), state))
    const approvals = ofType(parts, 'tool-approval-request')
    expect(approvals.map((part) => [part.approvalId, part.toolCall.toolCallId, part.toolCall.toolName])).toEqual([
      ['approval-1', 'execute-1/1', 'example_read'],
      ['approval-2', 'execute-1/2', 'example_read'],
    ])
    expect(approvals[0]!.toolCall.input).toBe(JSON.stringify({ path: 'a' }))
  })

  it('keeps an approval it cannot place on the program card rather than dropping it', () => {
    const state = createStreamState({ nestedResults: memoryResults([]) })
    convertEventToStreamParts(executePart('running', [{ tool: 'example.read', status: 'running' }]), state)
    const parts = convertEventToStreamParts(permission('approval-x', 'something_else'), state)
    expect(ofType(parts, 'tool-approval-request').map((part) => [part.approvalId, part.toolCall.toolCallId])).toEqual([['approval-x', 'execute-1']])
  })

  it('settles calls the program left behind when it ends, and returns the program result once', () => {
    const state = createStreamState({ nestedResults: memoryResults([]) })
    const parts = convertEventToStreamParts(executePart('running', [{ tool: 'example.read', status: 'running' }]), state)
    const completed = executePart('error', [{ tool: 'example.read', status: 'running' }])
    parts.push(...convertEventToStreamParts(completed, state), ...convertEventToStreamParts(completed, state))
    expect(ofType(parts, 'tool-error').map((part) => part.toolCallId)).toEqual(['execute-1/1', 'execute-1'])
    expect(ofType(parts, 'tool-call')).toHaveLength(2)
  })
})

describe('OpenCode Code Mode results plugin', () => {
  it('records nested results next to itself, one JSON line per call, and leaves other calls alone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'operon-codemode-plugin-'))
    const file = path.join(dir, 'plugin.mjs')
    writeFileSync(file, OPENCODE_CALLER_PLUGIN_SOURCE)
    const mod = (await import(pathToFileURL(file).href)) as { OperonCallerIdentity: (input: unknown) => Promise<Record<string, (input: unknown, output: unknown) => Promise<void>>> }
    const hooks = await mod.OperonCallerIdentity({ client: { session: { get: async () => ({ data: {} }) } } })
    const after = hooks['tool.execute.after']!

    await after({ tool: 'read', sessionID: 's', callID: 'toolu_1', args: {} }, { title: '', output: 'direct', metadata: {} })
    await after({ tool: 'github_list_issues', sessionID: 's', callID: 'call/1', args: { repo: 'x' } }, { content: [{ type: 'text', text: 'one' }, { type: 'image', data: '' }, { type: 'text', text: 'two' }] })
    await after({ tool: 'github_get', sessionID: 's', callID: 'call/2', args: {} }, { content: [], structuredContent: { ok: true } })

    const lines = readFileSync(path.join(dir, 'nested', 'call.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as NestedResult)
    expect(lines).toEqual([
      { tool: 'github_list_issues', args: { repo: 'x' }, output: 'one\ntwo' },
      { tool: 'github_get', args: {}, output: '{"ok":true}' },
    ])
  })
})
