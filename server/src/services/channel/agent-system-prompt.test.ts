import { describe, expect, it } from 'vitest'
import { buildPeerFollowUpPrompt, buildRecoveryPrompt, buildWakeUpPrompt } from './agent-system-prompt.js'

const line = '[target=#test msg=0000000b time=2026-11-22 19:15:25 sender=user type=user] 在么'

describe('wake-up prompts carry the messages themselves', () => {
  it('hands over the unread messages, already read, with no "go check" step', () => {
    const text = buildWakeUpPrompt('#test', { lines: [line], omitted: 0 })
    expect(text).toContain('New messages in #test (now marked read):')
    expect(text).toContain(line)
    expect(text).not.toContain('Call check_messages')
  })

  it('points to read_history for older messages it leaves out', () => {
    expect(buildWakeUpPrompt('#test', { lines: [line], omitted: 5 })).toContain('5 earlier unread message(s) not shown')
  })

  it('says so when nothing is unread', () => {
    expect(buildWakeUpPrompt('#test', { lines: [], omitted: 0 })).toContain('There are no unread messages in #test.')
  })

  it('keeps the follow-up guidance and the last-follow-up note', () => {
    const text = buildPeerFollowUpPrompt('#test', { lines: [line], omitted: 0 }, true)
    expect(text).toContain(line)
    expect(text).toContain('materially new')
    expect(text).toContain('last agent-to-agent follow-up')
  })

  it('recovery reads memory first, then gets the messages', () => {
    const text = buildRecoveryPrompt('#test', { lines: [line], omitted: 0 })
    expect(text.indexOf('MEMORY.md')).toBeLessThan(text.indexOf(line))
  })
})
