import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStreamPart } from '@operon/agent-runtime'

const inbox = vi.hoisted(() => ({ notify: vi.fn(), markRead: vi.fn((): number[] => []) }))
vi.mock('./state.js', () => ({
  getChatHistoryService: () => ({ getChatMeta: () => ({ title: 'Child chat' }) }),
  getNotificationStorage: () => ({ notificationMarkReadBySource: inbox.markRead, notificationGet: () => undefined }),
}))
vi.mock('../notification-service.js', () => ({ notify: inbox.notify, emitCounts: vi.fn() }))
vi.mock('../channel-bus.js', () => ({ emitInboxEvent: vi.fn() }))

const registry = await import('./chat-pending-input.js')
await import('./approval-inbox.js')

const request = (approvalId: string, toolName: string, input?: unknown) =>
  ({ type: 'tool-approval-request', approvalId, toolCall: { toolCallId: `call-${approvalId}`, toolName, input } }) as unknown as RuntimeStreamPart

describe('chat pending input', () => {
  let changes: Array<{ reason: string; chatId: number; pending: number; first?: boolean }>

  beforeEach(() => {
    registry.clearPendingApprovals(7)
    registry.clearPendingApprovals(8)
    inbox.notify.mockClear()
    inbox.markRead.mockClear()
    changes = []
    registry.subscribePendingInput((change) => {
      changes.push({
        reason: change.reason,
        chatId: change.chatId,
        pending: change.pending.length,
        ...(change.reason === 'requested' ? { first: change.first } : {}),
      })
    })
  })

  it('reports each chat\'s whole pending list as requests come and go', () => {
    registry.observePendingInputPart(7, request('a1', 'Bash', { command: 'rm -rf   build\n && ls' }), { userFacing: true })
    registry.observePendingInputPart(7, request('a2', 'Edit', { file_path: '/w/x.ts', old_string: 'a' }), { userFacing: true })

    expect(registry.listPendingApprovals(7).map((p) => p.inputPreview)).toEqual(['rm -rf build && ls', '/w/x.ts'])
    expect(registry.listChatsAwaitingInput()).toEqual([
      { chatId: 7, pending: registry.listPendingApprovals(7).map(registry.summarizePendingInput) },
    ])

    registry.resolvePendingApproval(7, 'a1')
    registry.resolvePendingApproval(7, 'unknown')
    registry.observePendingInputPart(7, { type: 'finish' } as RuntimeStreamPart, { userFacing: true })
    registry.observePendingInputPart(7, { type: 'finish' } as RuntimeStreamPart, { userFacing: true })

    expect(changes.filter((c) => c.chatId === 7)).toEqual([
      { reason: 'requested', chatId: 7, pending: 1, first: true },
      { reason: 'requested', chatId: 7, pending: 2, first: false },
      { reason: 'resolved', chatId: 7, pending: 1 },
      { reason: 'cleared', chatId: 7, pending: 0 },
    ])
    expect(registry.listChatsAwaitingInput()).toEqual([])
  })

  it('keeps the full tool input off the stream summary', () => {
    registry.observePendingInputPart(8, request('q1', 'AskUserQuestion'), {
      userFacing: true, origin: 'agent-3', toolInput: { questions: [{ question: 'Which?' }] },
    })
    const [summary] = registry.listChatsAwaitingInput()[0].pending
    expect(summary).not.toHaveProperty('toolInput')
    expect(summary).toMatchObject({ approvalId: 'q1', origin: 'agent-3', userFacing: true })
  })

  it('lets the inbox announce user-facing requests and retire them once answered', () => {
    registry.observePendingInputPart(8, request('b1', 'Bash'), { userFacing: false })
    expect(inbox.notify).not.toHaveBeenCalled()

    registry.observePendingInputPart(7, request('a1', 'Bash'), { userFacing: true })
    registry.observePendingInputPart(7, request('a2', 'ExitPlanMode'), { userFacing: true })
    expect(inbox.notify.mock.calls.map(([, n]) => [n.push, n.body])).toEqual([
      [true, 'Waiting for approval · Bash'],
      [false, 'The agent proposed a plan for review'],
    ])

    registry.resolvePendingApproval(7, 'a1')
    expect(inbox.markRead).not.toHaveBeenCalled()
    registry.resolvePendingApproval(7, 'a2')
    expect(inbox.markRead).toHaveBeenCalledWith('chat:7', 'chat_needs_input')

    // A turn that simply ends leaves the row for chat_complete to replace.
    registry.observePendingInputPart(7, request('a3', 'Bash'), { userFacing: true })
    registry.clearPendingApprovals(7)
    expect(inbox.markRead).toHaveBeenCalledTimes(1)
  })
})
