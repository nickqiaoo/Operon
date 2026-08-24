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
  const controller = {
    enqueue: (part: RuntimeStreamPart) => parts.push(part),
  } as ReadableStreamDefaultController<RuntimeStreamPart>

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
