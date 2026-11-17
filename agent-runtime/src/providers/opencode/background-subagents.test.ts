import { describe, expect, it, vi } from 'vitest'
import type { OpenCodeEvent, SessionMessageInfo } from '@opencode/client'
import { OpencodeRuntimeSession } from './session.js'
import { OpencodeClientManager } from './client-manager.js'
import { opencodeSubagentTranscriptFrom } from './subagent-transcript.js'
import { createRuntimeContext } from '../../context.js'
import type { RuntimeBackgroundEvent, RuntimeBackgroundTask, RuntimeStreamPart } from '../../types.js'

// Event sequence recorded from OpenCode 2.3.0: the parent launches a sub-agent,
// replies and goes idle; the sub-agent finishes later, its report reaches the
// parent's inbox, and the parent starts a reply of its own.

let created = 0
function event<T extends OpenCodeEvent['type']>(type: T, data: Extract<OpenCodeEvent, { type: T }>['data']): OpenCodeEvent {
  return { id: `event-${++created}`, created: ++created, type, data, durable: { aggregateID: 'x', seq: 1, version: 1 } } as OpenCodeEvent
}

const PARENT = 'session-1'
const CHILD = 'ses_child'
const tokens = { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
const model = { providerID: 'provider', id: 'model' }

function reply(sessionID: string, messageID: string, text: string): OpenCodeEvent[] {
  const step = { sessionID, assistantMessageID: messageID }
  return [
    event('session.step.started', { ...step, agent: 'build', model, started: 1 }),
    event('session.text.started', { ...step, ordinal: 0 }),
    event('session.text.delta', { ...step, ordinal: 0, delta: text }),
    event('session.text.ended', { ...step, ordinal: 0, text }),
    event('session.step.ended', { ...step, tokens, finish: 'stop', cost: 0 }),
  ]
}

const launchRun = (): OpenCodeEvent[] => {
  const step = { sessionID: PARENT, assistantMessageID: 'launch' }
  return [
    event('session.execution.started', { sessionID: PARENT }),
    event('session.step.started', { ...step, agent: 'build', model, started: 1 }),
    event('session.tool.input.started', { ...step, id: 'call-1', name: 'subagent' }),
    event('session.tool.input.ended', { ...step, id: 'call-1', text: '{}' }),
    event('session.tool.called', { ...step, id: 'call-1', input: { agent: 'general', description: 'Run the check', prompt: 'Check it' }, executed: true }),
    event('session.created', { sessionID: CHILD, parentID: PARENT } as Extract<OpenCodeEvent, { type: 'session.created' }>['data']),
    event('session.tool.success', { ...step, id: 'call-1', content: [{ type: 'text', text: `The subagent is working in the background (sessionID: ${CHILD}).` }], metadata: { sessionID: CHILD, status: 'running' }, executed: true }),
    event('session.step.ended', { ...step, tokens, finish: 'tool-calls', cost: 0 }),
    ...reply(PARENT, 'launched', 'LAUNCHED'),
    event('session.execution.succeeded', { sessionID: PARENT }),
  ]
}

const childWork = (): OpenCodeEvent[] => {
  const step = { sessionID: CHILD, assistantMessageID: 'child-step' }
  return [
    event('session.execution.started', { sessionID: CHILD }),
    event('session.step.started', { ...step, agent: 'general', model, started: 1 }),
    event('session.tool.input.started', { ...step, id: 'child-call', name: 'shell' }),
    event('session.tool.called', { ...step, id: 'child-call', input: { command: 'sleep 1' }, executed: true }),
    event('session.tool.success', { ...step, id: 'child-call', content: [{ type: 'text', text: 'ok' }], metadata: { status: 'completed' }, executed: true }),
    event('session.step.ended', { ...step, tokens, finish: 'tool-calls', cost: 0 }),
  ]
}

const report = (): OpenCodeEvent[] => [
  event('session.execution.succeeded', { sessionID: CHILD }),
  event('session.inbox.enqueued', {
    sessionID: PARENT,
    inboxID: 'inbox-report',
    item: {
      type: 'synthetic',
      delivery: 'steer',
      payload: {
        text: `<subagent sessionID="${CHILD}" state="completed" description="Run the check">\nAll good\n</subagent>`,
        description: 'Run the check',
        metadata: { source: 'subagent', childID: CHILD, agent: 'General', state: 'completed' },
      },
    },
  }),
  event('session.execution.started', { sessionID: PARENT }),
  event('session.inbox.delivered', { sessionID: PARENT, inboxID: 'inbox-report' }),
  ...reply(PARENT, 'answer', 'The check passed'),
  event('session.execution.succeeded', { sessionID: PARENT }),
]

/** A server event stream the test feeds as it goes. */
function liveServer() {
  const queue: OpenCodeEvent[] = []
  let wake: (() => void) | null = null
  const signals: AbortSignal[] = []
  return {
    signals,
    push(...events: OpenCodeEvent[]) {
      queue.push(...events)
      wake?.()
      wake = null
    },
    subscribe: vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal)
      return {
        async *[Symbol.asyncIterator]() {
          yield event('server.connected', {})
          while (!signal.aborted) {
            const next = queue.shift()
            if (next) {
              yield next
              continue
            }
            await new Promise<void>((resolve) => {
              wake = resolve
              signal.addEventListener('abort', () => resolve(), { once: true })
            })
          }
        },
      }
    }),
  }
}

function fixture() {
  const server = liveServer()
  const native = {
    session: {
      create: vi.fn(async () => ({ id: PARENT })),
      switchModel: vi.fn(async () => {}), switchAgent: vi.fn(async () => {}), update: vi.fn(async () => {}),
      prompt: vi.fn(async () => {
        // The parent's first run, once the prompt is admitted.
        queueMicrotask(() => server.push(...launchRun()))
        return { id: 'input' }
      }),
      interrupt: vi.fn(async () => {}),
      context: vi.fn(async () => [] as unknown[]),
      instructions: { entry: { put: vi.fn(async () => {}) } },
    },
    model: { list: vi.fn(async () => ({ data: [] })) },
    command: { list: vi.fn(async () => ({ data: [] })) },
    event: { subscribe: server.subscribe },
    mcp: { list: vi.fn(async () => ({ data: [] })) },
  }
  const ctx = createRuntimeContext()
  Object.assign(OpencodeClientManager.getInstance(ctx), { getClient: vi.fn(async () => native) })
  const session = new OpencodeRuntimeSession({ cwd: '/workspace', model: 'provider/model' }, ctx)
  const tasks: RuntimeBackgroundTask[][] = []
  const turns: AsyncIterable<RuntimeStreamPart>[] = []
  session.onBackground((backgroundEvent: RuntimeBackgroundEvent) => {
    if (backgroundEvent.type === 'tasks') tasks.push(backgroundEvent.tasks)
    if (backgroundEvent.type === 'turn') turns.push(backgroundEvent.parts)
  })
  return { session, native, server, tasks, turns }
}

async function drain(parts: AsyncIterable<RuntimeStreamPart>): Promise<RuntimeStreamPart[]> {
  const out: RuntimeStreamPart[] = []
  for await (const part of parts) out.push(part)
  return out
}

const text = (parts: RuntimeStreamPart[]) =>
  parts.flatMap((part) => part.type === 'text-delta' ? [part.text] : []).join('')

describe('OpenCode background sub-agents', () => {
  it('follows a sub-agent past the turn that launched it and hands the reply it prompts to the background listener', async () => {
    const { session, server, tasks, turns } = fixture()

    const launched = await drain(session.send('Check it in the background'))
    expect(text(launched)).toBe('LAUNCHED')
    expect(launched).toContainEqual(expect.objectContaining({ type: 'finish', finishReason: 'stop' }))
    expect(tasks.at(-1)).toEqual([expect.objectContaining({
      taskId: CHILD, toolUseId: 'call-1', taskType: 'subagent:general', backgrounded: true, description: 'Run the check', status: 'running',
    })])
    // The stream outlives the turn while the sub-agent runs.
    expect(server.signals[0]?.aborted).toBe(false)

    server.push(...childWork())
    await vi.waitFor(() => expect(tasks.at(-1)?.[0]).toMatchObject({ toolUses: 1, lastToolName: 'shell' }))

    server.push(...report())
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    const answer = await drain(turns[0]!)
    expect(text(answer)).toBe('The check passed')
    expect(answer).toContainEqual(expect.objectContaining({ type: 'finish', finishReason: 'stop' }))
    // The sub-agent's own steps never land in the parent's later reply.
    expect(answer.some((part) => part.type === 'tool-input-start')).toBe(false)
    expect(tasks.at(-1)?.[0]).toMatchObject({ status: 'completed', summary: 'All good' })

    // Nothing left to wait for: the stream closes, and it was only ever opened once.
    await vi.waitFor(() => expect(server.signals[0]?.aborted).toBe(true))
    expect(server.subscribe).toHaveBeenCalledTimes(1)
  })

  it('hands a run the parent starts as the turn ends to the background listener instead of dropping it', async () => {
    const { session, native, server, turns } = fixture()
    // The report lands in the same burst as the launching run's completion.
    native.session.prompt.mockImplementationOnce(async () => {
      queueMicrotask(() => server.push(...launchRun(), ...childWork(), ...report()))
      return { id: 'input' }
    })

    const launched = await drain(session.send('Check it'))
    expect(text(launched)).toBe('LAUNCHED')
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    expect(text(await drain(turns[0]!))).toBe('The check passed')
  })

  it('makes the next user turn wait for a reply the agent started on its own', async () => {
    const { session, native, server, turns } = fixture()
    await drain(session.send('Check it'))
    server.push(...childWork(), ...report().slice(0, 4))
    await vi.waitFor(() => expect(turns).toHaveLength(1))

    native.session.prompt.mockImplementationOnce(async () => {
      queueMicrotask(() => server.push(event('session.execution.started', { sessionID: PARENT }), ...reply(PARENT, 'next', 'Next'), event('session.execution.succeeded', { sessionID: PARENT })))
      return { id: 'input' }
    })
    const background = drain(turns[0]!)
    const next = drain(session.send('And now?'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(native.session.prompt).toHaveBeenCalledTimes(1)

    server.push(...reply(PARENT, 'answer', 'The check passed'), event('session.execution.succeeded', { sessionID: PARENT }))
    expect(text(await background)).toBe('The check passed')
    expect(text(await next)).toBe('Next')
    expect(native.session.prompt).toHaveBeenCalledTimes(2)
  })

  it('stops a background sub-agent by interrupting its session', async () => {
    const { session, native, server, tasks } = fixture()
    await drain(session.send('Check it'))
    await session.native.tasks.stop(CHILD)
    expect(native.session.interrupt).toHaveBeenCalledWith({ sessionID: CHILD })

    server.push(event('session.execution.interrupted', { sessionID: CHILD, reason: 'user' }))
    await vi.waitFor(() => expect(tasks.at(-1)?.[0]).toMatchObject({ status: 'stopped' }))

    await session.native.tasks.stop('ses_unknown')
    expect(native.session.interrupt).toHaveBeenCalledTimes(1)
  })
})

describe('OpenCode sub-agent transcript', () => {
  it('reads a sub-agent\'s steps and whether it finished from its session history', () => {
    const messages = [
      { id: 'u', type: 'user', text: 'You are a subagent', time: { created: 1 } },
      {
        id: 'a', type: 'assistant', agent: 'general', model, time: { created: 2 },
        content: [
          { type: 'reasoning', text: 'Run it' },
          { type: 'tool', id: 'c1', name: 'shell', state: { status: 'completed', input: { command: 'ls' }, content: [{ type: 'text', text: 'a.txt\n' }] }, time: { created: 2 } },
          { type: 'tool', id: 'c2', name: 'read', state: { status: 'error', input: { path: 'x' }, error: { type: 'unknown', message: 'missing' } }, time: { created: 3 } },
        ],
      },
      { id: 'b', type: 'assistant', agent: 'general', model, time: { created: 4 }, content: [{ type: 'text', text: 'Done' }] },
      { id: 'i', type: 'idle', outcome: 'succeeded', time: { created: 5 } },
    ] as unknown as SessionMessageInfo[]

    expect(opencodeSubagentTranscriptFrom(messages)).toEqual({
      finished: true,
      steps: [
        { toolCallId: 'c1', toolName: 'shell', input: { command: 'ls' }, state: 'output-available', output: 'a.txt\n' },
        { toolCallId: 'c2', toolName: 'read', input: { path: 'x' }, state: 'output-error', errorText: 'missing' },
      ],
    })
    expect(opencodeSubagentTranscriptFrom(messages.slice(0, 2)).finished).toBe(false)
  })
})
