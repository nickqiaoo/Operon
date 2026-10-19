import { describe, expect, it } from 'vitest'
import { createAscendingMessageId } from './message-id.js'

describe('createAscendingMessageId', () => {
  it("matches OpenCode's own format", () => {
    expect(createAscendingMessageId()).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  })

  it('sorts by time, and within one millisecond by creation order', () => {
    const ids = [createAscendingMessageId(1_000), createAscendingMessageId(1_000), createAscendingMessageId(2_000)]
    expect([...ids].sort()).toEqual(ids)
  })

  it('keeps the low 48 bits like OpenCode, so it sorts among the ids OpenCode makes', () => {
    // A live 1.19.3 session made msg_14cd2fa0c001… one millisecond before 1792290257421.
    const ours = createAscendingMessageId(1792290257421)
    expect(ours.slice(4, 16)).toBe('14cd2fa0d001')
    expect(['msg_14cd2fa0c001NsknoovT2yqo7n', ours].sort()[1]).toBe(ours)
  })
})
