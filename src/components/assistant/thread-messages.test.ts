import { describe, expect, it } from 'vitest'
import type { AssistantMessage } from './types'
import { latestActivityMessages, nextUserText } from './thread-messages'

const message = (id: string, activityId?: string, text = ''): AssistantMessage => ({
  id, activityId, text, role: 'assistant', createdAt: 1000,
})

describe('nextUserText', () => {
  const user = (id: string, text: string): AssistantMessage => ({ id, text, role: 'user', createdAt: 1000 })

  it('finds the first thing the user said after the message, skipping replies', () => {
    const messages = [user('before', 'hi'), message('q'), message('later', undefined, 'More.'), user('a', 'Codex'), user('b', 'Claude')]
    expect(nextUserText(messages, 1)).toBe('Codex')
  })

  it('is undefined until the user has said something, and empty for an attachment alone', () => {
    expect(nextUserText([user('before', 'hi'), message('q')], 1)).toBeUndefined()
    expect(nextUserText([message('q'), user('file', '')], 0)).toBe('')
  })
})

describe('coding activity entries in the assistant thread', () => {
  it('places one entry at the latest reply after a notice, a continued card and the final reply', () => {
    const messages = [
      message('commentary', undefined, 'Looking into it.'),
      message('reply', 'coding-1', 'The previous result.'),
      message('continued-card', 'coding-1'),
      message('final', 'coding-1', 'The updated result.'),
    ]
    expect([...latestActivityMessages(messages)]).toEqual([['coding-1', 'final']])
    // Selection changes the entry's location, never the messages or their text.
    expect(messages.map((m) => m.text)).toEqual(['Looking into it.', 'The previous result.', '', 'The updated result.'])
  })

  it('moves the entry to a continued task card and keeps different activities independent', () => {
    expect([...latestActivityMessages([
      message('old-reply', 'coding-1', 'Done.'),
      message('another', 'coding-2', 'Done.'),
      message('continued-card', 'coding-1'),
    ])]).toEqual([['coding-1', 'continued-card'], ['coding-2', 'another']])
  })
})
