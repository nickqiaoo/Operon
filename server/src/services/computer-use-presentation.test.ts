import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  endComputerUseHostSession,
  publishComputerUsePresentationEvent,
  setComputerUseEndHostSessionHandler,
  setComputerUsePresentationSink,
} from './computer-use-presentation.ts'

afterEach(() => {
  setComputerUsePresentationSink(undefined)
  setComputerUseEndHostSessionHandler(async () => {})
})

describe('Computer Use presentation lifecycle', () => {
  it('ends only host sessions that announced an active presentation', async () => {
    const ended = vi.fn(async () => {})
    const events: Array<{ type: string; hostSessionID?: string }> = []
    setComputerUseEndHostSessionHandler(ended)
    setComputerUsePresentationSink((event) => events.push(event))

    await endComputerUseHostSession('inactive-chat')
    expect(ended).not.toHaveBeenCalled()

    publishComputerUsePresentationEvent({
      type: 'active',
      hostSessionID: 'chat-42',
      displayName: 'System Settings',
    })
    await endComputerUseHostSession('chat-42')

    expect(ended).toHaveBeenCalledWith('chat-42')
    expect(events).toEqual([
      expect.objectContaining({ type: 'active', hostSessionID: 'chat-42' }),
      { type: 'ended', hostSessionID: 'chat-42', reason: 'turn-ended' },
    ])
  })
})
