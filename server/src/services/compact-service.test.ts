import { describe, it, expect } from 'vitest'
import type { ModelMessage, UIMessage } from 'ai'
import { buildCompactAwareView } from './compact-service.js'
import { applyApprovalResponseToHistory, mergeConsecutiveSameRole } from './ai.js'

const textMessage = (
  id: string,
  role: 'user' | 'assistant',
  text: string,
  metadata?: Record<string, unknown>,
): UIMessage => ({
  id,
  role,
  ...(metadata ? { metadata } : {}),
  parts: [{ type: 'text', text }],
})

describe('buildCompactAwareView', () => {
  it('returns the input unchanged when no compact marker is present', () => {
    const history: UIMessage[] = [
      textMessage('m1', 'user', 'hello'),
      textMessage('m2', 'assistant', 'hi'),
      textMessage('m3', 'user', 'second'),
    ]
    expect(buildCompactAwareView(history)).toEqual(history)
  })

  it('rewrites the marked assistant message as a user turn and drops anything before', () => {
    const history: UIMessage[] = [
      textMessage('m1', 'user', 'hello'),
      textMessage('m2', 'assistant', 'hi'),
      textMessage('m3', 'user', 'earlier request'),
      textMessage('m4', 'assistant', 'earlier answer'),
      textMessage('m5', 'assistant', 'SUMMARY', { compact: true }),
      textMessage('m6', 'user', 'next turn'),
    ]
    const result = buildCompactAwareView(history)
    expect(result).toHaveLength(2)
    expect(result[0].role).toBe('user')
    expect(result[0].id).toBe('compact-m5')
    const firstPart = result[0].parts[0]
    expect(firstPart.type).toBe('text')
    if (firstPart.type === 'text') {
      expect(firstPart.text).toBe('SUMMARY')
    }
    expect(result[1]).toEqual(history[5])
  })

  it('picks the most recent marker when several exist', () => {
    const history: UIMessage[] = [
      textMessage('m1', 'user', 'hello'),
      textMessage('m2', 'assistant', 'old summary', { compact: true }),
      textMessage('m3', 'user', 'more talk'),
      textMessage('m4', 'assistant', 'new summary', { compact: true }),
      textMessage('m5', 'user', 'next turn'),
    ]
    const result = buildCompactAwareView(history)
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('compact-m4')
    const firstPart = result[0].parts[0]
    if (firstPart.type === 'text') {
      expect(firstPart.text).toBe('new summary')
    }
    expect(result[1].id).toBe('m5')
  })

  it('returns a single summary-as-user when the marker is the final message', () => {
    const history: UIMessage[] = [
      textMessage('m1', 'user', 'hello'),
      textMessage('m2', 'assistant', 'SUMMARY', { compact: true }),
    ]
    const result = buildCompactAwareView(history)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('user')
    expect(result[0].id).toBe('compact-m2')
  })

  it('ignores non-assistant messages even when they carry the marker by accident', () => {
    const history: UIMessage[] = [
      textMessage('m1', 'user', 'hello', { compact: true }),
      textMessage('m2', 'assistant', 'hi'),
    ]
    expect(buildCompactAwareView(history)).toEqual(history)
  })
})

describe('mergeConsecutiveSameRole', () => {
  it('leaves an alternating sequence untouched', () => {
    const input: ModelMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]
    expect(mergeConsecutiveSameRole(input)).toEqual(input)
  })

  it('merges two consecutive user messages into one with concatenated parts', () => {
    const input: ModelMessage[] = [
      { role: 'user', content: 'summary' },
      { role: 'user', content: 'kept first user' },
      { role: 'assistant', content: 'reply' },
    ]
    const merged = mergeConsecutiveSameRole(input)
    expect(merged).toHaveLength(2)
    expect(merged[0].role).toBe('user')
    expect(Array.isArray(merged[0].content)).toBe(true)
    expect(merged[0].content).toEqual([
      { type: 'text', text: 'summary' },
      { type: 'text', text: 'kept first user' },
    ])
    expect(merged[1]).toEqual({ role: 'assistant', content: 'reply' })
  })

  it('preserves existing array content when merging', () => {
    const input: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: 'second' },
    ]
    const merged = mergeConsecutiveSameRole(input)
    expect(merged).toHaveLength(1)
    expect(merged[0].content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])
  })

  it('does not merge consecutive system or tool messages', () => {
    const input: ModelMessage[] = [
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
    ]
    expect(mergeConsecutiveSameRole(input)).toEqual(input)
  })
})

describe('applyApprovalResponseToHistory', () => {
  it('patches the latest matching approval tool state in-place', () => {
    const dbHistory: UIMessage[] = [
      textMessage('m1', 'user', 'hello'),
      {
        id: 'm2',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Checking permission' },
          {
            type: 'dynamic-tool',
            state: 'approval-requested',
            toolCallId: 'tool-1',
            approval: { id: 'approval-1' },
            input: { path: '/tmp' },
            toolName: 'Read',
          },
        ],
      },
    ]

    const patched = applyApprovalResponseToHistory(dbHistory, {
      approvalId: 'approval-1',
      approved: true,
      state: 'approval-responded',
    })

    expect(patched).not.toBeNull()
    expect(patched?.assistantIndex).toBe(1)
    const toolPart = patched?.assistantMessage.parts[1] as {
      state?: string
      approval?: { id: string; approved?: boolean }
    }
    expect(toolPart.state).toBe('approval-responded')
    expect(toolPart.approval).toEqual({ id: 'approval-1', approved: true })
  })

  it('returns null when no tool part matches the approval id', () => {
    const dbHistory: UIMessage[] = [
      textMessage('m1', 'user', 'hello'),
      {
        id: 'm2',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            state: 'approval-requested',
            toolCallId: 'tool-1',
            approval: { id: 'approval-1' },
            input: { path: '/tmp' },
            toolName: 'Read',
          },
        ],
      },
    ]

    const patched = applyApprovalResponseToHistory(dbHistory, {
      approvalId: 'approval-2',
      approved: false,
      state: 'approval-responded',
    })

    expect(patched).toBeNull()
  })
})
