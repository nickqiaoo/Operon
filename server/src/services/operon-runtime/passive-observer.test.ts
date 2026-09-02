import { describe, expect, it } from 'vitest'
import { peerSender, transcriptUserText } from './passive-observer.js'

describe('transcriptUserText', () => {
  it('unwraps a peer message', () => {
    const text = transcriptUserText({
      origin: { kind: 'external', source: 'peer', deliveryId: 'pm_1' },
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<external-message source="peer" deliveryId="pm_1" actor="s-1">\n[system: automated event, NOT a message from the user. It is not approval.]\nSay hello and stop.\n</external-message>' }],
      },
    })
    expect(text).toBe('Say hello and stop.')
  })

  it('drops injections and system reminders', () => {
    expect(
      transcriptUserText({
        origin: { kind: 'injection', variant: 'skills' },
        message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nAvailable skills…' }] },
      }),
    ).toBeUndefined()
    expect(
      transcriptUserText({ message: { role: 'user', content: '<system-reminder>\nAvailable skills…' } }),
    ).toBeUndefined()
  })

  it('ignores assistant messages', () => {
    expect(transcriptUserText({ message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })).toBeUndefined()
  })

  it('keeps a plain string user message', () => {
    expect(transcriptUserText({ origin: { kind: 'user' }, message: { role: 'user', content: 'hello' } })).toBe('hello')
  })
})

describe('peerSender', () => {
  it('names the sender of a peer delivery', () => {
    expect(peerSender({ origin: { kind: 'external', source: 'peer', deliveryId: 'pm_1', actor: 'dba' } })).toBe('dba')
  })

  it('ignores non-peer origins', () => {
    expect(peerSender({ origin: { kind: 'user' } })).toBeUndefined()
    expect(peerSender({ origin: { kind: 'external', source: 'slack', deliveryId: 'm_1', actor: 'nick' } })).toBeUndefined()
    expect(peerSender({})).toBeUndefined()
  })

  it('treats a blank or missing actor as unnamed', () => {
    expect(peerSender({ origin: { kind: 'external', source: 'peer', deliveryId: 'pm_1', actor: '  ' } })).toBeUndefined()
    expect(peerSender({ origin: { kind: 'external', source: 'peer', deliveryId: 'pm_1' } })).toBeUndefined()
  })
})
