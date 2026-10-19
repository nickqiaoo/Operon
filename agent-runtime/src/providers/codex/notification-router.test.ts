import { describe, expect, it } from 'vitest'
import type { RuntimeStreamPart } from '../../types.js'
import type { AppServerClient } from './sdk/app-server-client.js'
import { NotificationRouter } from './notification-router.js'
import { CodexTextStreamEmitter } from './text-stream-emitter.js'

type NotificationHandler = (params: unknown) => void

function createClientHarness() {
  const handlers = new Map<string, Set<NotificationHandler>>()
  const client = {
    onNotification(method: string, handler: NotificationHandler) {
      const methodHandlers = handlers.get(method) ?? new Set<NotificationHandler>()
      methodHandlers.add(handler)
      handlers.set(method, methodHandlers)
      return () => methodHandlers.delete(handler)
    },
    onRequest() {
      return () => undefined
    },
  } as unknown as AppServerClient

  return {
    client,
    emit(method: string, params: unknown) {
      for (const handler of handlers.get(method) ?? []) handler(params)
    },
  }
}

function createEmitter(parts: RuntimeStreamPart[]) {
  // Spelled out rather than cast: `parts.push` returns a number where `enqueue`
  // returns void, so the cast only ever type-checked by accident.
  const controller: ReadableStreamDefaultController<RuntimeStreamPart> = {
    desiredSize: null,
    enqueue: (part) => {
      parts.push(part)
    },
    close: () => {},
    error: () => {},
  }

  return new CodexTextStreamEmitter(controller, {
    threadId: 'thread-1',
    turnId: 'turn-1',
    modelId: 'gpt-5',
  })
}

describe('NotificationRouter context compaction', () => {
  it('emits live and completed metadata for the current protocol item', () => {
    const parts: RuntimeStreamPart[] = []
    const harness = createClientHarness()
    const router = new NotificationRouter(harness.client, createEmitter(parts), {
      threadId: 'thread-1',
      turnId: 'turn-1',
      onTurnCompleted: () => undefined,
    })
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'contextCompaction', id: 'compact-1' },
    }

    router.subscribe()
    harness.emit('item/started', params)
    harness.emit('item/completed', params)
    router.unsubscribe()

    const metadata = parts
      .filter((part): part is Extract<RuntimeStreamPart, { type: 'message-metadata' }> =>
        part.type === 'message-metadata',
      )
      .map((part) => part.metadata)

    expect(metadata).toEqual([
      {
        contextCompaction: { id: 'compact-1', status: 'in_progress' },
      },
      {
        compacted: { compacted: true, id: 'compact-1' },
        contextCompaction: { id: 'compact-1', status: 'completed' },
      },
    ])
  })
})

describe('NotificationRouter injected input', () => {
  function setup(pending: Map<string, { id: string; text: string }>) {
    const parts: RuntimeStreamPart[] = []
    const harness = createClientHarness()
    const router = new NotificationRouter(harness.client, createEmitter(parts), {
      threadId: 'thread-1',
      turnId: 'turn-1',
      onTurnCompleted: () => undefined,
      takeInjection: (clientId) => {
        const injected = pending.get(clientId)
        pending.delete(clientId)
        return injected
      },
    })
    router.subscribe()
    const emit = (method: string, item: Record<string, unknown>) =>
      harness.emit(method, { threadId: 'thread-1', turnId: 'turn-1', item })
    return { parts, harness, router, emit }
  }
  const injectedParts = (parts: RuntimeStreamPart[]) => parts.filter((part) => part.type === 'injected-input')

  it('holds a message Codex accepted mid-tool until the model takes its next step', () => {
    const { parts, router, emit } = setup(new Map([['client-1', { id: 'steer-1', text: 'Mention BANANA' }]]))
    const sleep = { type: 'commandExecution', id: 'cmd-1', command: 'sleep 8', status: 'inProgress' }

    emit('item/started', sleep)
    // The turn's own prompt carries no client id; an id we did not send is not ours.
    emit('item/started', { type: 'userMessage', id: 'u-0', clientId: null, content: [] })
    emit('item/started', { type: 'userMessage', id: 'u-1', clientId: 'client-1', content: [] })
    emit('item/started', { type: 'userMessage', id: 'u-2', clientId: 'someone-else', content: [] })
    // Accepted, but the model has not read it: nothing yet, even when the tool ends.
    expect(injectedParts(parts)).toEqual([])
    emit('item/completed', { ...sleep, status: 'completed', aggregatedOutput: '' })
    expect(injectedParts(parts)).toEqual([])

    emit('item/started', { type: 'agentMessage', id: 'a-2', text: '' })
    router.unsubscribe()

    expect(injectedParts(parts)).toEqual([{ type: 'injected-input', id: 'steer-1', text: 'Mention BANANA' }])
    const marker = parts.indexOf(injectedParts(parts)[0])
    const toolResult = parts.findIndex((part) => part.type === 'tool-result')
    expect(toolResult).toBeGreaterThan(-1)
    expect(marker).toBeGreaterThan(toolResult)
  })

  it('still places one the turn ended without reading', () => {
    const { parts, harness, router, emit } = setup(new Map([['client-1', { id: 'steer-1', text: 'Late' }]]))
    emit('item/started', { type: 'userMessage', id: 'u-1', clientId: 'client-1', content: [] })
    harness.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    router.unsubscribe()
    expect(injectedParts(parts)).toEqual([{ type: 'injected-input', id: 'steer-1', text: 'Late' }])
  })
})
