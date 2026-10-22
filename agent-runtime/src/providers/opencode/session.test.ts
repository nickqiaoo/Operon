import { describe, expect, it, vi } from 'vitest'
import type { OpenCodeEvent, McpServer, ModelInfo, ProviderInfo, SessionPromptInput, SessionCommandInput, CommandInfo } from '@opencode/client'
import { OpencodeRuntimeProvider } from './index.js'
import { OpencodeRuntimeSession, listOpencodeDescriptorModels } from './session.js'
import { createRuntimeContext } from '../../context.js'
import type { RuntimeStreamPart, SessionOptions } from '../../types.js'
import { OpencodeClientManager } from './client-manager.js'
import { SIDE_CHAT_BOUNDARY_PROMPT } from '../../side-chat-prompt.js'

function event<T extends OpenCodeEvent['type']>(type: T, data: Extract<OpenCodeEvent, { type: T }>['data']): OpenCodeEvent {
  return { id: 'event', created: 1, type, data, durable: { aggregateID: 'session-1', seq: 1, version: 1 } } as OpenCodeEvent
}
const tokens = { input: 100, output: 10, reasoning: 2, cache: { read: 40, write: 20 } }
const model = { id: 'model', providerID: 'provider', name: 'Model', enabled: true, variants: [{ id: 'low' }, { id: 'high' }], limit: { context: 1000, output: 100 } } as ModelInfo
const step = { sessionID: 'session-1', assistantMessageID: 'answer' }
const replyEvents = [
  event('session.step.started', { ...step, agent: 'build', model: { providerID: 'provider', id: 'model' }, started: 1 }),
  event('session.text.started', { ...step, ordinal: 0 }),
  event('session.text.delta', { ...step, ordinal: 0, delta: 'Hello' }),
  event('session.text.ended', { ...step, ordinal: 0, text: 'Hello' }),
  event('session.step.ended', { ...step, tokens, finish: 'stop', cost: 0.01 }),
  event('session.execution.succeeded', { sessionID: 'session-1' }),
]

function fixture(options: Partial<SessionOptions> = {}, events = replyEvents) {
  let servers: McpServer[] = [{ name: 'browser', status: { status: 'connected' } }]
  const native = {
    session: {
      create: vi.fn(async () => ({ id: 'session-1' })),
      fork: vi.fn(async () => ({ id: 'session-1' })),
      switchModel: vi.fn(async () => {}), switchAgent: vi.fn(async () => {}), update: vi.fn(async () => {}),
      prompt: vi.fn(async (_input: SessionPromptInput) => ({ id: 'input' })), remove: vi.fn(async () => {}), interrupt: vi.fn(async () => {}),
      command: vi.fn(async (_input: SessionCommandInput) => {}),
      compact: vi.fn(async () => {}), wait: vi.fn(async () => {}), context: vi.fn(async () => [] as unknown[]),
      instructions: { entry: { put: vi.fn(async () => {}) } },
      form: { reply: vi.fn(async () => {}), cancel: vi.fn(async () => {}) },
    },
    model: { list: vi.fn(async () => ({ data: [model] })) },
    provider: { list: vi.fn(async () => ({ data: [{ id: 'provider', name: 'Provider' }] as ProviderInfo[] })) },
    command: { list: vi.fn(async () => ({ data: [] as CommandInfo[] })) },
    skill: { list: vi.fn(async () => ({ data: [{ id: 'review', description: 'Review skill' }] })) },
    config: { get: vi.fn(async () => [{ type: 'document', info: { compaction: { auto: false } } }]) },
    event: { subscribe: vi.fn((_options?: { signal?: AbortSignal }) => ({ async *[Symbol.asyncIterator]() {
      yield event('server.connected', {})
      yield* events
    } })) },
    mcp: {
      list: vi.fn(async () => ({ data: servers })), add: vi.fn(async () => {}),
      connect: vi.fn(async () => { servers = [{ name: 'browser', status: { status: 'connected' } }] }),
      disconnect: vi.fn(async () => { servers = [{ name: 'browser', status: { status: 'disabled' } }] }),
    },
    permission: { reply: vi.fn(async () => {}) },
  }
  const ctx = createRuntimeContext()
  const manager = OpencodeClientManager.getInstance(ctx)
  Object.assign(manager, { getClient: vi.fn(async () => native) })
  const session = new OpencodeRuntimeSession({ cwd: '/workspace', model: 'provider/model', ...options }, ctx)
  return { session, native, ctx }
}
async function collect(session: OpencodeRuntimeSession) {
  const parts: RuntimeStreamPart[] = []
  for await (const part of session.send('Hello')) parts.push(part)
  return parts
}

describe('OpenCode V2 native session', () => {
  it('discovers native commands alongside skills without duplicating names or compact', async () => {
    const { ctx, native } = fixture()
    native.command.list.mockResolvedValue({ data: [{ name: 'review', description: 'Review command' }, { name: 'docs:search', description: 'Search docs' }, { name: 'compact' }] })
    const provider = new OpencodeRuntimeProvider(ctx)
    await provider.createSession({ cwd: '/workspace', model: 'provider/model' })
    const descriptor = await provider.getDescriptor()
    expect(descriptor.slashCommands).toEqual([
      { name: 'review', description: 'Review command', type: 'command' },
      { name: 'docs:search', description: 'Search docs', type: 'command' },
      { name: 'compact', description: 'Compact conversation history', type: 'command' },
    ])
    expect(descriptor.commands.map((entry) => entry.id)).toEqual(['review', 'docs:search', 'compact'])
    expect(native.command.list).toHaveBeenCalledWith({ location: { directory: '/workspace' } })
  })

  it('executes registered commands with arguments, selected skills and attachments', async () => {
    const { session, native } = fixture()
    native.command.list.mockResolvedValue({ data: [{ name: 'docs:search' }] })
    const parts: RuntimeStreamPart[] = []
    for await (const part of session.send([
      { type: 'text', text: '[skill:review] /docs:search src/auth.ts "error handling"' },
      { type: 'file', data: 'data:text/plain;base64,SGVsbG8=', mediaType: 'text/plain', filename: 'context.txt' },
    ])) parts.push(part)
    expect(native.session.command).toHaveBeenCalledWith({ sessionID: 'session-1', name: 'docs:search', text: 'src/auth.ts "error handling"', skills: [{ id: 'review' }], files: [{ uri: 'data:text/plain;base64,SGVsbG8=', name: 'context.txt' }] })
    expect(native.session.prompt).not.toHaveBeenCalled()
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish', finishReason: 'stop' }))
  })

  it('keeps the side-chat boundary when invoking a native command', async () => {
    const { session, native } = fixture({ fork: { from: 'parent' } })
    native.command.list.mockResolvedValue({ data: [{ name: 'team/review' }] })
    for await (const _part of session.send('/team/review changes')) { /* drain */ }
    expect(native.session.command).toHaveBeenCalledWith(expect.objectContaining({ name: 'team/review', text: `${SIDE_CHAT_BOUNDARY_PROMPT}\nchanges` }))
  })

  it('keeps unknown slash text and absolute paths as ordinary messages', async () => {
    const { session, native } = fixture()
    for await (const _part of session.send('/workspace/src/file.ts')) { /* drain */ }
    expect(native.session.command).not.toHaveBeenCalled()
    expect(native.session.prompt).toHaveBeenCalledWith(expect.objectContaining({ text: '/workspace/src/file.ts' }))
  })

  it('surfaces a rejected command as an error without sending its text as a prompt', async () => {
    const { session, native } = fixture()
    native.command.list.mockResolvedValue({ data: [{ name: 'review' }] })
    native.session.command.mockRejectedValueOnce(new Error('Command failed'))
    const parts: RuntimeStreamPart[] = []
    for await (const part of session.send('/review')) parts.push(part)
    expect(parts).toContainEqual({ type: 'error', error: new Error('Command failed') })
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish', finishReason: 'error' }))
    expect(native.session.prompt).not.toHaveBeenCalled()
  })

  it('streams one reply and reports measured tokens, cache and cost', async () => {
    const { session, native } = fixture()
    const parts = await collect(session)
    expect(parts.filter((part) => part.type === 'text-delta')).toEqual([{ type: 'text-delta', id: 'answer-text-0', text: 'Hello' }])
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish', finishReason: 'stop', totalUsage: expect.objectContaining({ inputTokens: 160, outputTokens: 10 }) }))
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish-step', providerMetadata: expect.objectContaining({ opencode: expect.objectContaining({ cost: 0.01 }) }) }))
    expect(native.session.prompt).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'session-1', text: 'Hello' }))
  })

  it('switches model, agent and effort on the existing server session', async () => {
    const { session, native } = fixture({ resume: 'session-1' })
    await session.set({ model: 'provider/family/model-2', mode: 'plan', effort: 'high' })
    expect(native.session.switchModel).toHaveBeenCalledWith({ sessionID: 'session-1', model: { providerID: 'provider', id: 'family/model-2', variant: 'high' } })
    expect(native.session.switchAgent).toHaveBeenCalledWith({ sessionID: 'session-1', agent: 'plan' })
    expect(native.session.create).not.toHaveBeenCalled()
    expect(native.session.interrupt).not.toHaveBeenCalled()
    expect(session.state()).toEqual({ currentModelId: 'provider/family/model-2', currentModeId: 'plan', currentThinkingLevel: 'high' })
  })

  it('accumulates turn usage across steps while retaining the latest context footprint', async () => {
    const { session } = fixture({}, [...replyEvents.slice(0, -1), ...replyEvents])
    const parts = await collect(session)
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish', totalUsage: expect.objectContaining({ inputTokens: 320, outputTokens: 20, raw: expect.objectContaining({ total_cost: 0.02 }) }) }))
    const metadata = parts.filter((part) => part.type === 'message-metadata').at(-1)
    expect(metadata).toEqual(expect.objectContaining({ metadata: expect.objectContaining({ contextUsage: { promptTokens: 160 } }) }))
  })

  it('passes selected skills through native prompt references', async () => {
    const { session, native } = fixture()
    for await (const _part of session.send('[skill:review] Check this change')) { /* drain */ }
    expect(native.session.prompt).toHaveBeenCalledWith(expect.objectContaining({ text: 'Check this change', skills: [{ id: 'review' }] }))
  })

  it('grants full access explicitly and removes its override when leaving it', async () => {
    const { session, native } = fixture({ resume: 'session-1' })
    await session.set({ mode: 'fullAccess' })
    expect(native.session.update).toHaveBeenLastCalledWith({ sessionID: 'session-1', permissions: [{ action: '*', resource: '*', effect: 'allow' }] })
    await session.set({ mode: 'build' })
    expect(native.session.update).toHaveBeenLastCalledWith({ sessionID: 'session-1', permissions: [] })
  })

  it('keeps settings selected before startup and reuses the session on later messages', async () => {
    const { session, native } = fixture()
    await session.set({ effort: 'high' })
    expect(native.session.create).not.toHaveBeenCalled()
    await collect(session)
    await collect(session)
    expect(native.session.create).toHaveBeenCalledOnce()
    expect(native.session.switchModel).toHaveBeenCalledOnce()
    expect(native.session.switchModel).toHaveBeenCalledWith(expect.objectContaining({ model: expect.objectContaining({ variant: 'high' }) }))
  })

  it('reports rejected SDK updates without claiming a different model', async () => {
    const { session, native } = fixture({ resume: 'session-1' })
    native.session.switchModel.mockRejectedValueOnce(new Error('Unknown model'))
    await expect(session.set({ model: 'provider/missing' })).rejects.toThrow('Unknown model')
    expect(session.state().currentModelId).toBe('provider/model')
  })

  it('clears an inherited effort when switching to a model without that variant', async () => {
    const { session, native } = fixture({ resume: 'session-1', model: 'provider/other', effort: 'max' })
    await session.set({ model: 'provider/model' })
    expect(native.session.switchModel).toHaveBeenCalledWith({ sessionID: 'session-1', model: { providerID: 'provider', id: 'model', variant: undefined } })
    expect(session.state().currentThinkingLevel).toBeUndefined()
  })

  it('restores host instructions on resumed sessions', async () => {
    const { session, native } = fixture({ resume: 'session-1', instructions: 'Host instructions' })
    await collect(session)
    expect(native.session.instructions.entry.put).toHaveBeenCalledWith({ sessionID: 'session-1', key: 'operon', value: 'Host instructions' })
    expect(native.session.create).not.toHaveBeenCalled()
  })

  it('forks only once and deletes only its own ephemeral branch', async () => {
    const { session, native } = fixture({ fork: { from: 'parent' } })
    await collect(session)
    await collect(session)
    expect(native.session.fork).toHaveBeenCalledOnce()
    expect(native.session.fork).toHaveBeenCalledWith({ sessionID: 'parent' })
    expect(native.session.prompt.mock.calls[0][0]).toEqual(expect.objectContaining({ text: expect.stringContaining(SIDE_CHAT_BOUNDARY_PROMPT) }))
    expect(native.session.prompt.mock.calls[1][0]).toEqual(expect.objectContaining({ text: 'Hello' }))
    await session.close('rebuild')
    expect(native.session.remove).not.toHaveBeenCalled()
    await session.close()
    expect(native.session.remove).toHaveBeenCalledWith({ sessionID: 'session-1' })
  })

  it('adds steer input using the native admission API', async () => {
    const { session, native } = fixture({ resume: 'session-1' })
    await session.inject('Focus on tests', { id: 'steer-id' })
    expect(native.session.prompt).toHaveBeenCalledWith({ sessionID: 'session-1', text: 'Focus on tests', id: expect.stringMatching(/^msg_/), delivery: 'steer' })
  })

  it('reports provider errors as a failed stream', async () => {
    const { session } = fixture({}, [event('session.execution.failed', { sessionID: 'session-1', error: { type: 'provider.invalid-request', message: 'Unsupported model' } })])
    const parts = await collect(session)
    expect(parts).toContainEqual({ type: 'error', error: new Error('Unsupported model') })
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish', finishReason: 'error' }))
  })

  it('stops provider retries that require a quota or authentication action', async () => {
    const { session, native } = fixture({}, [event('session.status', { sessionID: 'session-1', status: { type: 'retry', attempt: 1, message: 'Limit', next: 1, action: { reason: 'free_tier_limit', provider: 'opencode', title: 'Limit', message: 'Free usage exceeded', label: 'Upgrade' } } })])
    const parts = await collect(session)
    expect(parts).toContainEqual({ type: 'error', error: new Error('Free usage exceeded') })
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish', finishReason: 'error' }))
    expect(native.session.interrupt).toHaveBeenCalledWith({ sessionID: 'session-1' })
  })

  it('reports remote interruptions as cancellation', async () => {
    const { session } = fixture({}, [event('session.execution.interrupted', { sessionID: 'session-1', reason: 'user' })])
    expect(await collect(session)).toContainEqual({ type: 'abort' })
  })

  it('does not silently finish when the event connection drops', async () => {
    const { session } = fixture({}, [])
    const parts = await collect(session)
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish', finishReason: 'error' }))
  })

  it('shows and answers native permissions using their originating session', async () => {
    const tool = { ...step, id: 'tool' }
    const { session, native } = fixture({}, [
      ...replyEvents.slice(0, 1),
      event('session.tool.input.started', { ...tool, name: 'shell' }),
      event('session.tool.called', { ...tool, input: { command: 'pwd' }, executed: false }),
      event('permission.asked', { id: 'approval', sessionID: 'session-1', action: 'shell', resources: ['pwd'], source: { type: 'tool', messageID: 'answer', id: 'tool' } }),
      ...replyEvents.slice(4),
    ])
    for await (const part of session.send('Hello')) {
      if (part.type === 'tool-approval-request') expect(session.respond(part.approvalId, { type: 'allow' })).toBe(true)
    }
    expect(native.permission.reply).toHaveBeenCalledWith({ sessionID: 'session-1', requestID: 'approval', decision: 'once' })
  })

  it('maps native forms into questions and maps labels back to option values', async () => {
    const { session, native } = fixture({}, [
      event('form.created', { form: { id: 'form', sessionID: 'session-1', title: 'Choose', fields: [{ type: 'string', key: 'color', title: 'Color', options: [{ label: 'Blue', value: 'blue' }] }] } }),
      event('session.idle', { sessionID: 'session-1' }),
    ])
    for await (const part of session.send('Hello')) {
      if (part.type === 'tool-approval-request') session.respond(part.approvalId, { type: 'allow', updatedInput: { answers: { Color: 'Blue' } } })
    }
    expect(native.session.form.reply).toHaveBeenCalledWith({ sessionID: 'session-1', formID: 'form', answer: { color: 'blue' } })
  })

  it('exposes the latest measured context footprint separately from session totals', async () => {
    const { session, native } = fixture({ resume: 'session-1' })
    native.session.context.mockResolvedValue([{ id: 'answer', type: 'assistant', tokens }])
    const usage = await session.contextUsage()
    expect(usage).toEqual(expect.objectContaining({ totalTokens: 160, maxTokens: 1000, percentage: 16, isAutoCompactEnabled: false, apiUsage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 40 } }))
  })

  it('discovers model-specific variants and context windows from V2', async () => {
    const { ctx } = fixture()
    expect(await listOpencodeDescriptorModels(ctx, '/workspace', 'provider/model')).toEqual({
      currentModelId: 'provider/model', models: [{ id: 'provider/model', name: 'Model', contextWindow: 1000, providerLabel: 'Provider', providerLogo: 'provider', supportedEffortLevels: ['low', 'high'] }],
    })
  })

  it('preserves provider groups, custom names and complete model IDs for the picker', async () => {
    const { ctx, native } = fixture()
    native.model.list.mockResolvedValue({ data: [
      { ...model, providerID: 'openai', id: 'gpt' },
      { ...model, providerID: 'xai', id: 'grok' },
      { ...model, providerID: 'work-openai', id: 'gpt' },
      { ...model, providerID: 'openai', id: 'hidden', enabled: false },
    ] })
    native.provider.list.mockResolvedValue({ data: [
      { id: 'openai', name: 'OpenAI' }, { id: 'xai', name: 'xAI' },
      { id: 'work-openai', name: 'Work OpenAI', canonical: 'openai' },
    ] as ProviderInfo[] })
    const result = await listOpencodeDescriptorModels(ctx, '/workspace', 'xai/grok')
    expect(result.models.map(({ id, providerLabel, providerLogo }) => ({ id, providerLabel, providerLogo }))).toEqual([
      { id: 'openai/gpt', providerLabel: 'OpenAI', providerLogo: 'openai' },
      { id: 'xai/grok', providerLabel: 'xAI', providerLogo: 'xai' },
      { id: 'work-openai/gpt', providerLabel: 'Work OpenAI', providerLogo: 'openai' },
    ])
    expect(result.currentModelId).toBe('xai/grok')
    expect(native.provider.list).toHaveBeenCalledWith({ location: { directory: '/workspace' } })
  })

  it('keeps models available when provider labels cannot be loaded', async () => {
    const { ctx, native } = fixture()
    native.provider.list.mockRejectedValueOnce(new Error('Unavailable'))
    const result = await listOpencodeDescriptorModels(ctx, '/workspace', 'provider/model')
    expect(result.models[0]).toEqual(expect.objectContaining({ id: 'provider/model', providerLabel: 'provider' }))
  })

  it('uses native MCP list, connect and disconnect contracts', async () => {
    const { session, native } = fixture()
    expect(await session.native.mcp.list()).toEqual([{ name: 'browser', status: 'connected' }])
    await session.native.mcp.toggle('browser', false)
    expect(native.mcp.disconnect).toHaveBeenCalledWith({ server: 'browser', location: { directory: '/workspace' } })
    await session.native.mcp.reconnect('browser')
    expect(native.mcp.connect).toHaveBeenCalledWith({ server: 'browser', location: { directory: '/workspace' } })
  })
})
