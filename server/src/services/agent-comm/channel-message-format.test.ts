import { describe, expect, it } from 'vitest'
import type { ChannelMessage, MessageSenderType } from '../../types/channel.js'
import { formatChannelMessage } from './channel-message-format.js'

function msg(senderType: MessageSenderType, senderName: string): ChannelMessage {
  return {
    id: 6,
    channelId: 1,
    threadRootId: null,
    senderType,
    senderId: senderType === 'agent' ? 5 : null,
    senderName,
    content: 'hi',
    replyCount: 0,
    lastReplyAt: null,
    senderBindingId: null,
    attachments: [],
    createdAt: 0,
  }
}

describe('formatChannelMessage', () => {
  it("shows the desktop client's `you` as `user`, so an agent doesn't read it as itself", () => {
    expect(formatChannelMessage(msg('human', 'you'), 'test')).toContain('sender=user type=user] hi')
  })

  it('keeps real names and labels each sender type', () => {
    expect(formatChannelMessage(msg('human', 'richard'), 'test')).toContain('sender=richard type=user]')
    expect(formatChannelMessage(msg('agent', 'luna-dev'), 'test')).toContain('sender=luna-dev type=agent]')
    expect(formatChannelMessage(msg('system', 'system'), 'test')).toContain('sender=system type=system]')
  })
})
