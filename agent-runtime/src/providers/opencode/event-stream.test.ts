import { describe, expect, it } from 'vitest'
import {
  convertChildEventToStreamParts,
  convertEventToStreamParts,
  createStreamState,
  tryRegisterChildFromSessionEvent,
  type EventMessagePartUpdated,
  type EventMessageUpdated,
} from './event-stream.js'

describe('opencode event stream child session routing', () => {
  it('registers pending task child sessions from session lifecycle events', () => {
    const state = createStreamState()

    convertEventToStreamParts({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'tool-part-1',
          sessionID: 'main-session',
          messageID: 'assistant-message',
          type: 'tool',
          callID: 'task-call-1',
          tool: 'task',
          state: {
            status: 'running',
            input: { description: 'Explore repo' },
            raw: '',
            time: { start: Date.now() },
          },
        },
      },
    } as EventMessagePartUpdated, state)

    const parentCallId = tryRegisterChildFromSessionEvent('child-session', state)

    expect(parentCallId).toBe('task-call-1')
    expect(state.childSessions.get('child-session')).toBe('task-call-1')
  })

  it('injects parentToolCallId into rerouted child tool parts', () => {
    const state = createStreamState()

    convertChildEventToStreamParts({
      type: 'message.updated',
      properties: {
        info: {
          id: 'child-assistant-message',
          sessionID: 'child-session',
          role: 'assistant',
        },
      },
    } as EventMessageUpdated, 'parent-call-1', state)

    const runningParts = convertChildEventToStreamParts({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'child-tool-part',
          sessionID: 'child-session',
          messageID: 'child-assistant-message',
          type: 'tool',
          callID: 'child-tool-call',
          tool: 'Bash',
          state: {
            status: 'running',
            input: { command: 'pwd' },
            raw: '',
            time: { start: Date.now() },
          },
        },
      },
    } as EventMessagePartUpdated, 'parent-call-1', state)

    const inputStart = runningParts.find((part) => part.type === 'tool-input-start')

    expect(inputStart && 'providerMetadata' in inputStart ? inputStart.providerMetadata : undefined).toEqual({
      opencode: { parentToolCallId: 'parent-call-1' },
    })

    const completedParts = convertChildEventToStreamParts({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'child-tool-part',
          sessionID: 'child-session',
          messageID: 'child-assistant-message',
          type: 'tool',
          callID: 'child-tool-call',
          tool: 'Bash',
          state: {
            status: 'completed',
            input: { command: 'pwd' },
            output: '/tmp',
            title: 'pwd',
            time: { start: Date.now(), end: Date.now() },
          },
        },
      },
    } as EventMessagePartUpdated, 'parent-call-1', state)

    const toolResult = completedParts.find((part) => part.type === 'tool-result')
    expect(toolResult && 'providerMetadata' in toolResult ? toolResult.providerMetadata : undefined).toEqual({
      opencode: { parentToolCallId: 'parent-call-1' },
    })
  })
})
