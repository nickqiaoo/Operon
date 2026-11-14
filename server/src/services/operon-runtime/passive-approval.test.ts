import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import { createHarness, createModelManager, type Harness } from 'operon-agents'
import type { RuntimeStreamPart } from '@operon/agent-runtime'

const captured = vi.hoisted(() => ({ parts: [] as RuntimeStreamPart[], onPart: undefined as ((part: RuntimeStreamPart) => void) | undefined }))

vi.mock('../ai/state.js', () => ({
  getChatStorage: () => ({ findChatBySessionId: () => ({ id: 42, tp: 'chat', model: 'faux' }) }),
  getNotificationStorage: () => null,
}))
vi.mock('../ai/persistence.js', () => ({ persistInjectedUserMessage: () => undefined }))
vi.mock('../notification-service.js', () => ({ notify: () => undefined }))
vi.mock('../ai/detached-turn.js', () => ({
  replySnippet: () => undefined,
  // Stand-in for the live-turn pipeline: drain the passive turn's parts, letting the test react.
  runDetachedTurn: async (_target: unknown, parts: AsyncIterable<RuntimeStreamPart>) => {
    for await (const part of parts) {
      captured.parts.push(part)
      captured.onPart?.(part)
    }
    return undefined
  },
}))

const { observeSession, resolvePassiveApproval, unobserveSession } = await import('./passive-observer.js')

let harness: Harness | undefined

afterEach(async () => {
  captured.parts = []
  captured.onPart = undefined
  await harness?.close()
  harness = undefined
})

async function openSession() {
  const handle = fauxProvider()
  const runtime = createModelManager({ builtins: false })
  runtime.models.setProvider(handle.provider)
  harness = createHarness({
    config: {
      defaults: { model: `${handle.provider.id}/${handle.getModel().id}`, permission: { mode: 'manual' } },
      workDir: mkdtempSync(path.join(tmpdir(), 'operon-passive-approval-')),
    },
    modelManager: runtime,
  })
  const session = await harness.createSession()
  observeSession(session)
  return { handle, session }
}

type ApprovalPart = { type: 'tool-approval-request'; approvalId: string; toolCall: { toolName: string; input: unknown } }

/**
 * A run nobody in operon started (here: `prompt` straight on the harness session, as a finished
 * background task's wake run is) used to have no live approval handler, so the harness parked it
 * durably — no approval card, a turn that never ended, and every later message refused with
 * "has an interrupted run".
 */
describe('approval in a turn operon did not start', () => {
  it('is asked on the passive turn and answered through resolvePassiveApproval', async () => {
    const { handle, session } = await openSession()
    handle.setResponses([
      fauxAssistantMessage(fauxToolCall('Bash', { command: 'git push', description: 'Push' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('skipped', { stopReason: 'stop' }),
    ])
    captured.onPart = (part) => {
      if (part.type !== 'tool-approval-request') return
      const request = part as unknown as ApprovalPart
      expect(resolvePassiveApproval(42, request.approvalId, { type: 'deny', reason: 'not now' })).toBe(true)
    }

    const result = await session.prompt('go')
    unobserveSession(session.id)

    expect(result.status).not.toBe('interrupted')
    expect(await session.pendingInterruptions()).toEqual([])
    const requests = captured.parts.filter((p) => p.type === 'tool-approval-request') as unknown as ApprovalPart[]
    expect(requests).toHaveLength(1)
    expect(requests[0]?.toolCall).toMatchObject({ toolName: 'Bash', input: { command: 'git push', description: 'Push' } })
  })

  it('does not answer an id from another chat', async () => {
    const { handle, session } = await openSession()
    handle.setResponses([
      fauxAssistantMessage(fauxToolCall('Bash', { command: 'git push', description: 'Push' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('skipped', { stopReason: 'stop' }),
    ])
    captured.onPart = (part) => {
      if (part.type !== 'tool-approval-request') return
      const { approvalId } = part as unknown as ApprovalPart
      expect(resolvePassiveApproval(7, approvalId, { type: 'allow' })).toBe(false)
      expect(resolvePassiveApproval(42, approvalId, { type: 'deny' })).toBe(true)
    }

    await session.prompt('go')
    unobserveSession(session.id)
  })
})
