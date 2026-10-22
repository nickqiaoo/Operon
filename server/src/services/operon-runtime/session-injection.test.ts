import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readUIMessageStream, type UIMessage } from 'ai'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Api, type Model } from '@earendil-works/pi-ai'
import { createHarness, type HarnessSession } from 'operon-agents'
import { createModelRuntime, defineModel, type AgentEvent, type AgentEventBody } from 'operon-agents-core'
import { RuntimeInjectionUnavailableError, type RuntimeStreamPart } from '@operon/agent-runtime'
import { toUIMessageStream } from '@operon/agent-runtime/ai-sdk'
import { OperonRuntimeSession } from './session.js'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup() {
  const listeners = new Set<(event: AgentEvent) => void>()
  const journal = deferred()
  let run = deferred()
  let state = 'idle'
  let steerSeq = 0
  const emit = (body: AgentEventBody, address = 'main') => {
    const event: AgentEvent = { eventId: 'event', sessionId: 'session', address, ...body }
    for (const listener of listeners) listener(event)
  }
  const finish = () => {
    state = 'idle'
    emit({ type: 'agent.ended', agent: 'main' })
    run.resolve()
  }
  const harness = {
    id: 'session',
    get status() { return { state } },
    onEvent(listener: (event: AgentEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    prompt: vi.fn(() => {
      state = 'running'
      run = deferred()
      emit({ type: 'turn.step.started', turnId: 'turn', step: 1, stepId: 'step-1' })
      return run.promise
    }),
    steer: vi.fn(() => ({ steerId: `framework-${++steerSeq}`, journaled: journal.promise })),
    cancel: vi.fn(finish),
    close: vi.fn(async () => { state = 'closed' }),
  }
  const session = new OperonRuntimeSession(harness as unknown as HarnessSession, 'test', 'manual')
  const start = () => {
    const parts: RuntimeStreamPart[] = []
    const done = (async () => { for await (const part of session.send('go')) parts.push(part) })()
    return { parts, done }
  }
  const consume = (steerId: string, address = 'main') => emit({
    type: 'message.appended',
    origin: { kind: 'user', steerId },
    message: { role: 'user', content: [{ type: 'text', text: 'framework message' }], timestamp: 0 },
  }, address)
  return { session, harness, journal, emit, finish, start, consume }
}

const markers = (parts: RuntimeStreamPart[]) => parts.filter((part) => part.type === 'injected-input')

describe('Operon injected input receipts', () => {
  it('uses real harness consumption to place the UI receipt after a running tool and before the next answer', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'operon-injection-'))
    const handle = fauxProvider()
    const runtime = createModelRuntime({ builtins: false })
    runtime.models.setProvider(handle.provider)
    const model = defineModel({ runtime, descriptor: handle.getModel() as Model<Api> })
    const toolStarted = deferred()
    const releaseTool = deferred()
    let nextRequest = ''
    const harness = createHarness({
      model,
      workDir,
      permission: { mode: 'yolo' },
      extensions: [{
        id: 'injection-test',
        session(api) {
          api.registerTool({
            name: 'WaitForSteer',
            description: 'Wait for a follow-up message.',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              toolStarted.resolve()
              await releaseTool.promise
              return 'tool done'
            },
          })
        },
      }],
    })
    try {
      const native = await harness.createSession()
      const session = new OperonRuntimeSession(native, 'test', 'yolo')
      handle.setResponses([
        fauxAssistantMessage([fauxText('Before'), fauxToolCall('WaitForSteer', {})], { stopReason: 'toolUse' }),
        (context) => {
          nextRequest = JSON.stringify(context.messages)
          return fauxAssistantMessage('After', { stopReason: 'stop' })
        },
      ])
      const parts: RuntimeStreamPart[] = []
      async function* stream() {
        for await (const part of session.send('go')) {
          parts.push(part)
          yield part
        }
      }
      let reply: UIMessage | undefined
      const done = (async () => {
        for await (const message of readUIMessageStream({
          stream: toUIMessageStream(stream(), { messageId: 'reply' }),
          terminateOnError: true,
        })) reply = message
      })()
      await toolStarted.promise
      await session.inject('Please change direction', { id: 'client-1' })
      expect(markers(parts)).toEqual([])
      releaseTool.resolve()
      await done

      expect(nextRequest).toContain('Please change direction')
      expect(markers(parts)).toEqual([{ type: 'injected-input', id: 'client-1', text: 'Please change direction' }])
      const markerIndex = parts.findIndex((part) => part.type === 'injected-input')
      expect(markerIndex).toBeGreaterThan(parts.findIndex((part) => part.type === 'tool-result'))
      expect(markerIndex).toBeLessThan(parts.findIndex((part) => part.type === 'text-delta' && part.text === 'After'))
      // The assembled, serializable message retains the marker in the same place.
      const saved: UIMessage = JSON.parse(JSON.stringify(reply))
      expect(saved.parts.map((part) => part.type)).toEqual([
        'step-start', 'text', 'dynamic-tool', 'data-injected-input', 'step-start', 'text',
      ])
      expect(saved.parts[3]).toMatchObject({
        type: 'data-injected-input', data: { id: 'client-1', text: 'Please change direction' },
      })
    } finally {
      releaseTool.resolve()
      await harness.close()
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('waits for durable enqueue and emits a single receipt only on consumption, even before inject resolves', async () => {
    const h = setup()
    const { parts, done } = h.start()
    let accepted = false
    const injection = h.session.inject('  change direction  ', { id: 'client-1' }).then(() => { accepted = true })
    await Promise.resolve()
    expect(accepted).toBe(false)
    expect(markers(parts)).toEqual([])

    // Consumption can beat the HTTP response; its id must already be registered.
    h.consume('framework-1')
    h.consume('framework-1')
    h.journal.resolve()
    await injection
    h.finish()
    await done
    expect(h.harness.steer).toHaveBeenCalledWith('change direction')
    expect(markers(parts)).toEqual([{ type: 'injected-input', id: 'client-1', text: 'change direction' }])
  })

  it('correlates identical messages by id and ignores nested and unrelated messages', async () => {
    const h = setup()
    const { parts, done } = h.start()
    h.journal.resolve()
    await h.session.inject('same text', { id: 'client-1' })
    await h.session.inject('same text', { id: 'client-2' })
    h.consume('framework-1', 'main/child')
    h.consume('someone-else')
    h.consume('framework-2')
    h.consume('framework-1')
    h.finish()
    await done
    expect(markers(parts)).toEqual([
      { type: 'injected-input', id: 'client-2', text: 'same text' },
      { type: 'injected-input', id: 'client-1', text: 'same text' },
    ])
  })

  it('does not acknowledge an unconsumed message on abort, and can acknowledge it in the next turn', async () => {
    const h = setup()
    const first = h.start()
    h.journal.resolve()
    await h.session.inject('later', { id: 'client-1' })
    h.session.abort()
    await first.done
    expect(markers(first.parts)).toEqual([])

    const next = h.start()
    h.consume('framework-1')
    h.finish()
    await next.done
    expect(markers(next.parts)).toEqual([{ type: 'injected-input', id: 'client-1', text: 'later' }])
  })

  it('rejects an idle injection before enqueueing and removes correlation when journaling fails', async () => {
    const h = setup()
    await expect(h.session.inject('too late', { id: 'idle' })).rejects.toBeInstanceOf(RuntimeInjectionUnavailableError)
    expect(h.harness.steer).not.toHaveBeenCalled()

    const { parts, done } = h.start()
    const injection = h.session.inject('no storage', { id: 'client-1' })
    h.journal.reject(new Error('write refused'))
    await expect(injection).rejects.toThrow('write refused')
    h.consume('framework-1')
    h.finish()
    await done
    expect(markers(parts)).toEqual([])
  })
})
