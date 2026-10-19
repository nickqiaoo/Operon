import { describe, expect, it, vi } from 'vitest'

// notify() relays to the broker, and a dev machine signed in to the SaaS has a real node
// token: without this, running the suite pushes test banners to the developer's phone.
vi.mock('../push-relay.js', () => ({ relayPush: vi.fn() }))
import type { AssistantMessage } from '../../../../shared/assistant.js'
import type { NotificationStorageAdapter } from '../../storage/interface.js'
import type { Notification, NotifyInput } from '../../types/notification.js'
import { AssistantNotifier, ASSISTANT_MESSAGE_SOURCE, assistantApprovalSource, snippet } from './notifier.js'

function fakeStorage() {
  const upserts: NotifyInput[] = []
  const retired: string[] = []
  const row = (input: NotifyInput): Notification => ({
    id: upserts.length,
    kind: input.kind,
    severity: input.severity,
    projectId: null,
    workspaceId: null,
    chatId: null,
    taskId: null,
    agentId: null,
    title: input.title,
    body: input.body ?? null,
    sourceKey: input.sourceKey,
    readAt: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
  })
  const storage = {
    notificationUpsert: (input: NotifyInput) => {
      upserts.push(input)
      return row(input)
    },
    notificationGet: () => null,
    notificationMarkReadBySource: (key: string) => {
      retired.push(key)
      return []
    },
    notificationUnreadCounts: () => ({ total: 0, action: 0 }),
  } as unknown as NotificationStorageAdapter
  return { storage, upserts, retired }
}

function setup(opts: { quiet?: boolean; viewed?: boolean } = {}) {
  const fake = fakeStorage()
  const notifier = new AssistantNotifier({
    storage: () => fake.storage,
    name: () => '小Q',
    quiet: () => opts.quiet ?? false,
    viewed: () => opts.viewed ?? false,
  })
  return { notifier, ...fake }
}

const msg = (id: string, text: string, trigger?: AssistantMessage['trigger']): AssistantMessage => ({
  id,
  role: 'assistant',
  text,
  createdAt: 0,
  ...(trigger ? { trigger } : {}),
})

describe('AssistantNotifier', () => {
  it('leaves replies to the user out', () => {
    const { notifier, upserts } = setup()
    notifier.message(msg('a', 'Sure, done.'))
    notifier.turnEnded()
    expect(upserts).toEqual([])
  })

  it('sends a turn spoken on its own once, with all of it', () => {
    const { notifier, upserts } = setup()
    notifier.message(msg('a', 'Morning brief:', { kind: 'schedule', name: 'brief' }))
    notifier.message(msg('b', '**Nasdaq** fell 2%.', { kind: 'schedule', name: 'brief' }))
    // The same message re-emitted (gaining a remembered line) is not news.
    notifier.message(msg('b', '**Nasdaq** fell 2%.', { kind: 'schedule', name: 'brief' }))
    notifier.turnEnded()
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({
      kind: 'assistant_message',
      severity: 'info',
      sourceKey: ASSISTANT_MESSAGE_SOURCE,
      title: '小Q',
      body: 'Morning brief: Nasdaq fell 2%.',
      push: true,
    })
  })

  it('stays out of the inbox while the thread is on screen', () => {
    const { notifier, upserts } = setup({ viewed: true })
    notifier.message(msg('a', 'Done.', { kind: 'worker', activityId: 'w1' }))
    notifier.turnEnded()
    expect(upserts).toEqual([])
  })

  it('keeps the row but not the buzz in quiet hours, except a heartbeat finding', () => {
    const { notifier, upserts } = setup({ quiet: true })
    notifier.message(msg('a', 'Report ready.', { kind: 'worker', activityId: 'w1' }))
    notifier.turnEnded()
    notifier.message(msg('b', 'Server is down.', { kind: 'heartbeat' }))
    notifier.turnEnded()
    expect(upserts.map((u) => u.push)).toEqual([false, true])
  })

  it('raises a permission card as action and retires it once answered', () => {
    const { notifier, upserts, retired } = setup()
    const approval = { id: 'p1', title: 'Browser Use · Access https://x.com', detail: '', icon: 'globe' as const }
    notifier.approval(approval)
    expect(upserts[0]).toMatchObject({
      kind: 'assistant_approval',
      severity: 'action',
      sourceKey: assistantApprovalSource('p1'),
      body: 'Browser Use · Access https://x.com',
      push: true,
    })
    notifier.approval({ ...approval, decision: 'allowed_once' })
    expect(upserts).toHaveLength(1)
    expect(retired).toEqual([assistantApprovalSource('p1')])
  })

  it('does not buzz for a card in quiet hours', () => {
    const { notifier, upserts } = setup({ quiet: true })
    notifier.approval({ id: 'p1', title: 'x', detail: '', icon: 'tool' })
    expect(upserts[0]?.push).toBe(false)
  })
})

describe('snippet', () => {
  it('flattens markdown into one line', () => {
    expect(snippet('# Title\n\n- **one** [link](https://x)\n```\ncode\n```\n`x`')).toBe('Title one link x')
  })

  it('cuts long text', () => {
    const out = snippet('a'.repeat(300))
    expect(out.length).toBe(180)
    expect(out.endsWith('…')).toBe(true)
  })
})
