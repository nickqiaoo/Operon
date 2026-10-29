import { describe, expect, it } from 'vitest'
import {
  convertChildEventToStreamParts,
  convertEventToStreamParts,
  createFinishParts,
  createStreamState,
  formApprovalParts,
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

describe('OpenCode internal message filtering', () => {
  const message = (id: string, extra: Partial<EventMessageUpdated['properties']['info']> = {}): EventMessageUpdated => ({
    type: 'message.updated',
    properties: { info: { id, sessionID: 'session-1', role: 'assistant', ...extra } },
  })
  const text = (messageID: string, extra: Record<string, unknown> = {}): EventMessagePartUpdated => ({
    type: 'message.part.updated',
    properties: { part: { id: `${messageID}-text`, messageID, sessionID: 'session-1', type: 'text', text: '', ...extra } },
  })
  const delta = (messageID: string) => ({
    type: 'message.part.delta',
    properties: { sessionID: 'session-1', messageID, partID: `${messageID}-text`, field: 'text', delta: 'Hidden content' },
  })

  it.each([{ summary: true }, { agent: 'compaction' }, { mode: 'compaction' }])(
    'hides compaction text, reasoning, step events and usage: %j',
    (internal) => {
      const state = createStreamState()
      convertEventToStreamParts(message('answer', { tokens: { input: 100, output: 10 } }), state)
      convertEventToStreamParts(text('answer', { text: 'Hello!' }), state)
      convertEventToStreamParts(message('checkpoint', { ...internal, tokens: { input: 900, output: 300 } }), state)
      expect(convertEventToStreamParts(text('checkpoint', { text: '## Objective' }), state)).toEqual([])
      expect(convertEventToStreamParts(delta('checkpoint'), state)).toEqual([])
      for (const type of ['reasoning', 'step-start', 'step-finish']) {
        expect(convertEventToStreamParts(text('checkpoint', { type }), state)).toEqual([])
      }
      expect(state.messageUsage?.inputTokens).toBe(100)
      expect(convertEventToStreamParts(text('answer', { text: 'Hello! Again.' }), state)).toContainEqual({
        type: 'text-delta', id: 'answer-text', text: ' Again.',
      })
    },
  )

  it.each([{ role: 'user' as const }, { synthetic: true }, { ignored: true }])(
    'also filters hidden text from the delta path: %j',
    (hidden) => {
      const state = createStreamState()
      convertEventToStreamParts(message('hidden', 'role' in hidden ? hidden : {}), state)
      expect(convertEventToStreamParts(text('hidden', hidden), state)).toEqual([])
      expect(convertEventToStreamParts(delta('hidden'), state)).toEqual([])
      expect(state.textStarted).toBe(false)
    },
  )

  it('reports compaction after the last visible step has closed', () => {
    const state = createStreamState()
    convertEventToStreamParts({ type: 'session.compacted', properties: { sessionID: 'session-1' } }, state)
    const parts = createFinishParts(state, { unified: 'stop', raw: 'stop' }, 'session-1', 'model')
    expect(parts).toContainEqual(expect.objectContaining({
      type: 'message-metadata',
      metadata: expect.objectContaining({ compacted: { compacted: true } }),
    }))
    expect(parts.some((part) => part.type === 'text-start' || part.type === 'finish-step')).toBe(false)
  })
})

describe('opencode injected input', () => {
  const assistant = (id: string, parentID: string): EventMessageUpdated => ({
    type: 'message.updated',
    properties: { info: { id, sessionID: 'main-session', role: 'assistant', parentID } },
  })

  it('marks the first step that answers an injected message, once', () => {
    const pendingInjections = new Map([['msg_steer', { id: 'steer-1', text: 'Mention BANANA' }]])
    const state = createStreamState({ pendingInjections })

    // Steps answering the turn's own prompt say nothing about it.
    expect(convertEventToStreamParts(assistant('msg_a1', 'msg_prompt'), state)).toEqual([])
    const parts = convertEventToStreamParts(assistant('msg_a2', 'msg_steer'), state)
    expect(parts).toContainEqual({ type: 'injected-input', id: 'steer-1', text: 'Mention BANANA' })
    // Later steps of the same answer (and their updates) do not repeat it.
    expect(convertEventToStreamParts(assistant('msg_a2', 'msg_steer'), state)).toEqual([])
    expect(convertEventToStreamParts(assistant('msg_a3', 'msg_steer'), state)).toEqual([])
    expect(pendingInjections.size).toBe(0)
  })
})

describe('opencode form approvals', () => {
  const questionPart = (status: 'pending' | 'running') => ({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'call_q',
        sessionID: 'main-session',
        messageID: 'assistant-message',
        type: 'tool',
        callID: 'call_q',
        tool: 'question',
        state: status === 'running'
          ? { status, input: { questions: [{ question: 'Which file?' }] }, raw: '', time: { start: Date.now() } }
          : { status, input: {}, raw: '' },
      },
    },
  }) as EventMessagePartUpdated

  const input = JSON.stringify({ questions: [{ question: 'Which file?', header: 'Which file?', options: [] }] })

  it("puts a form's approval on the question call still open, announcing the call first", () => {
    const state = createStreamState()
    convertEventToStreamParts(questionPart('pending'), state)
    convertEventToStreamParts(questionPart('running'), state)

    const parts = formApprovalParts('frm_1', input, state)

    expect(parts.map((part) => part.type)).toEqual(['tool-input-end', 'tool-call', 'tool-approval-request'])
    const approval = parts.at(-1)
    expect(approval).toMatchObject({ approvalId: 'frm_1', toolCall: { toolCallId: 'call_q', toolName: 'AskUserQuestion', input } })
    // The call is announced: the question's own completion must not announce it again.
    expect(state.toolStates.get('call_q')?.callEmitted).toBe(true)
  })

  it('announces a call under the form id when no question call is open', () => {
    const parts = formApprovalParts('frm_2', input, createStreamState())

    expect(parts.map((part) => part.type)).toEqual(['tool-call', 'tool-approval-request'])
    expect(parts[1]).toMatchObject({ approvalId: 'frm_2', toolCall: { toolCallId: 'frm_2' } })
  })
})
