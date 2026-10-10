import { describe, expect, it } from 'vitest'
import type { AssistantApproval, AuditRecord } from '../../../../shared/assistant.js'
import { AssistantApprovals } from './approvals.js'

function setup() {
  const cards = new Map<string, AssistantApproval>()
  const audit: AuditRecord[] = []
  const waiting: Array<[string, boolean]> = []
  let n = 0
  const approvals = new AssistantApprovals(
    {
      card: (messageId, approval) => cards.set(messageId, approval),
      audit: (r) => audit.push(r),
      setWaiting: (id, w) => waiting.push([id, w]),
    },
    () => `id-${++n}`,
    () => 42,
  )
  return { approvals, cards, audit, waiting }
}

const input = { title: 'Browser Use · Access https://x.com', detail: 'Allow?', icon: 'globe' as const, activityId: 'w1' }

describe('AssistantApprovals', () => {
  it('posts a card, marks the worker waiting, and settles on the answer', async () => {
    const { approvals, cards, audit, waiting } = setup()
    const pending = approvals.request(input)
    const [messageId, card] = [...cards.entries()][0]
    expect(card).toMatchObject({ title: input.title, activityId: 'w1' })
    expect(card.decision).toBeUndefined()
    expect(waiting).toEqual([['w1', true]])

    expect(approvals.answer(card.id, 'always_allowed')).toBe(true)
    await expect(pending).resolves.toBe('always_allowed')
    expect(cards.get(messageId)!.decision).toBe('always_allowed')
    expect(audit).toEqual([expect.objectContaining({ title: input.title, decision: 'always_allowed', activityId: 'w1', at: 42 })])
    expect(waiting.at(-1)).toEqual(['w1', false])
    expect(approvals.answer(card.id, 'denied')).toBe(false)
  })

  it('keeps the worker waiting while another of its cards is open', async () => {
    const { approvals, cards, waiting } = setup()
    void approvals.request(input)
    void approvals.request({ ...input, title: 'second' })
    const first = [...cards.values()][0]
    approvals.answer(first.id, 'allowed_once')
    expect(waiting.filter(([, w]) => !w)).toEqual([])
  })

  it('expires the cards of a worker that went away, without auditing a decision', async () => {
    const { approvals, cards, audit } = setup()
    const pending = approvals.request(input)
    approvals.expireFor('w1')
    await expect(pending).resolves.toBe('expired')
    expect([...cards.values()][0].decision).toBe('expired')
    expect(audit).toEqual([])
  })
})
