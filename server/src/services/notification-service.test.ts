import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationStorageAdapter } from '../storage/interface.js'
import type { Notification, NotifyInput } from '../types/notification.js'
import type { TaskStatus } from '../types/task.js'

const mocks = vi.hoisted(() => ({ relayPush: vi.fn(), viewed: new Set<number>() }))
vi.mock('./push-relay.js', () => ({ relayPush: mocks.relayPush }))
vi.mock('./chat-viewers.js', () => ({ isChatBeingViewed: (chatId: number) => mocks.viewed.has(chatId) }))
vi.mock('./channel-bus.js', () => ({ emitInboxEvent: () => {} }))

const { notifyTaskStatusChange, notifyTaskTurnFinished, setTaskSessionResolver } = await import('./notification-service.js')

/** Just enough of the inbox table: one live row per source, as the real upsert keeps it. */
function fakeStorage() {
  const rows = new Map<string, Notification>()
  let nextId = 1
  const storage = {
    notificationUpsert(input: NotifyInput): Notification {
      const prev = rows.get(input.sourceKey)
      const row: Notification = {
        id: prev?.id ?? nextId++,
        kind: input.kind,
        severity: input.severity,
        projectId: input.projectId ?? null,
        workspaceId: input.workspaceId ?? null,
        chatId: input.chatId ?? null,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        title: input.title,
        body: input.body ?? null,
        sourceKey: input.sourceKey,
        readAt: null,
        archivedAt: null,
        createdAt: prev?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      }
      rows.set(input.sourceKey, row)
      return row
    },
    notificationGet: (id: number) => [...rows.values()].find((row) => row.id === id) ?? null,
    notificationUnreadCounts: () => ({ total: 0, action: 0 }),
  } as unknown as NotificationStorageAdapter
  return { storage, rows }
}

const session = { chatId: 40, workspaceId: 10, agentId: 7 }
const task = (id: number, status: TaskStatus) => ({ id, projectId: 1, number: id, title: `Task ${id}`, status })

describe('task notifications', () => {
  beforeEach(() => {
    mocks.relayPush.mockReset()
    mocks.viewed.clear()
    setTaskSessionResolver(() => session)
  })

  it("announces a turn that answered a comment on the task's own row, without a push", () => {
    const { storage, rows } = fakeStorage()
    notifyTaskTurnFinished(storage, task(1, 'in_review'), session, Date.now())

    expect(rows.get('task:1')).toMatchObject({ kind: 'task_reply', severity: 'action', chatId: 40, body: 'Agent replied · #1' })
    expect(mocks.relayPush).not.toHaveBeenCalled()
  })

  it('is info while the task is still being worked on', () => {
    const { storage, rows } = fakeStorage()
    notifyTaskTurnFinished(storage, task(2, 'in_progress'), session, Date.now())
    expect(rows.get('task:2')).toMatchObject({ kind: 'task_reply', severity: 'info' })
  })

  it('leaves the status notice alone when the same turn moved the task', () => {
    const { storage, rows } = fakeStorage()
    const turnStartedAt = Date.now() - 1000
    notifyTaskStatusChange(storage, task(3, 'in_progress'), 'in_review', 'in_progress')
    notifyTaskTurnFinished(storage, task(3, 'in_review'), session, turnStartedAt)

    expect(rows.get('task:3')).toMatchObject({ kind: 'task_in_review', body: 'Ready for review · #3', chatId: 40 })
    expect(mocks.relayPush).toHaveBeenCalledOnce()
  })

  it('stays quiet when the task waits on the user, is closed, or its session is on screen', () => {
    const { storage, rows } = fakeStorage()
    for (const [id, status] of [[4, 'needs_input'], [5, 'done'], [6, 'cancelled']] as const) {
      notifyTaskTurnFinished(storage, task(id, status), session, Date.now())
    }
    mocks.viewed.add(40)
    notifyTaskTurnFinished(storage, task(7, 'in_review'), session, Date.now())

    expect(rows.size).toBe(0)
  })
})
