import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { goalFromLastAssistant } from './useGoal'

const assistant = (id: string, metadata?: unknown): UIMessage => ({ id, role: 'assistant', parts: [], metadata })

describe('goal stream snapshots', () => {
  it('reads the common goal field emitted by both runtimes, including terminal status and spend', () => {
    const goal = { objective: 'Ship the fix', status: 'complete', tokensUsed: 2150, timeUsedSeconds: 30 }
    expect(goalFromLastAssistant([assistant('a', { goal })], 0)).toEqual(goal)
  })

  it('distinguishes an explicit clear from missing metadata', () => {
    expect(goalFromLastAssistant([assistant('a', { goal: null })], 0)).toBeNull()
    expect(goalFromLastAssistant([assistant('a', { usage: {} })], 0)).toBeUndefined()
  })

  it('ignores older pursuits and preserves an update through a metadata-free assistant message', () => {
    const old = assistant('old', { goal: { objective: 'Old', status: 'complete' } })
    const goal = { objective: 'New', status: 'blocked' }
    expect(goalFromLastAssistant([old], 1)).toBeUndefined()
    expect(goalFromLastAssistant([old, assistant('new', { goal }), assistant('tail')], 1)).toEqual(goal)
  })
})
