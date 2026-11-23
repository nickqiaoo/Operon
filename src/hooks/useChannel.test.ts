import { describe, expect, it } from 'vitest'
import { confirmLocal, localMessage } from './useChannel'
import type { ChannelMessage } from '@/types/channel'

function saved(id: number, content: string, threadRootId: number | null = null): ChannelMessage {
  return { ...localMessage(1, threadRootId, content, []), id, localState: undefined, createdAt: 1 }
}

describe('confirmLocal', () => {
  it('swaps the local copy for the saved one when the POST answers first', () => {
    const local = localMessage(1, null, 'hi', [])
    const list = confirmLocal([saved(5, 'before'), local], saved(9, 'hi'), local.id)
    expect(list.map((m) => [m.id, m.localState])).toEqual([[5, undefined], [9, undefined]])
  })

  it('drops the local copy when the stream delivers the saved one first, and the late POST adds nothing', () => {
    const local = localMessage(1, null, 'hi', [])
    const afterStream = confirmLocal([local], saved(9, 'hi'))
    expect(afterStream.map((m) => m.id)).toEqual([9])
    expect(confirmLocal(afterStream, saved(9, 'hi'), local.id).map((m) => m.id)).toEqual([9])
  })

  it('keeps local messages after every saved one, in the order sent', () => {
    const a = localMessage(1, null, 'a', [])
    const b = localMessage(1, null, 'b', [])
    const list = confirmLocal([a, b], { ...saved(12, 'agent reply'), senderType: 'agent' })
    expect(list.map((m) => m.content)).toEqual(['agent reply', 'a', 'b'])
  })

  it('does not take a failed copy or one in another thread for the stream match', () => {
    const failed = { ...localMessage(1, null, 'hi', []), localState: 'failed' as const }
    const inThread = localMessage(1, 3, 'hi', [])
    const list = confirmLocal([failed, inThread], saved(9, 'hi'))
    expect(list.map((m) => m.id)).toEqual([9, failed.id, inThread.id])
  })
})
