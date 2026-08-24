import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { mergeServerTail } from './merge-server-tail'

const msg = (id: string, text = id): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
})

const ids = (messages: UIMessage[]) => messages.map((m) => m.id)

describe('mergeServerTail', () => {
  it('keeps history before the anchor and replaces from it on', () => {
    const current = [msg('a'), msg('b'), msg('c'), msg('d')]
    const tail = [msg('c', 'c-server'), msg('d', 'd-server'), msg('e')]

    const merged = mergeServerTail(current, tail)

    expect(ids(merged)).toEqual(['a', 'b', 'c', 'd', 'e'])
    // The overlap takes the server's version, not the one already in memory.
    expect(merged[2]).toBe(tail[0])
  })

  it('keeps scrolled-back history that the tail page does not reach', () => {
    // The regression this function exists for: older pages the user loaded by
    // scrolling up used to vanish on every reconnect.
    const current = [msg('old-1'), msg('old-2'), msg('recent')]

    const merged = mergeServerTail(current, [msg('recent'), msg('new')])

    expect(ids(merged)).toEqual(['old-1', 'old-2', 'recent', 'new'])
  })

  it('falls back to the server view when the pages do not overlap', () => {
    const current = [msg('a'), msg('b')]
    const tail = [msg('y'), msg('z')]

    // Splicing these together would claim b is followed by y, hiding whatever
    // the server recorded in between.
    expect(ids(mergeServerTail(current, tail))).toEqual(['y', 'z'])
  })

  it('leaves the list alone when the server returns nothing', () => {
    const current = [msg('a'), msg('b')]

    expect(mergeServerTail(current, [])).toBe(current)
  })

  it('adopts the server view when there is no local history yet', () => {
    expect(ids(mergeServerTail([], [msg('a')]))).toEqual(['a'])
  })

  it('drops local messages after the anchor that the server did not persist', () => {
    // An interrupted turn leaves a partial assistant message in memory; the
    // resumed transcript is authoritative about what actually got stored.
    const current = [msg('a'), msg('partial')]

    const merged = mergeServerTail(current, [msg('a', 'a-server')])

    expect(ids(merged)).toEqual(['a'])
  })
})
