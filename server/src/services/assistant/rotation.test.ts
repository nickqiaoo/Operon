import { describe, expect, it } from 'vitest'
import type { Activity, AssistantMessage, ProfileFile } from '../../../../shared/assistant.js'
import { buildSessionSeed, buildWrapUpTranscript, ContextReminder, lastBoundary, rotationDue } from './rotation.js'

const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime()
const msg = (role: 'user' | 'assistant', text: string, createdAt: number, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: `${role}-${createdAt}`,
  role,
  text,
  createdAt,
  ...extra,
})
const activity = (id: string, extra: Partial<Activity> = {}): Activity => ({
  id,
  taskId: `aw-${id}`,
  title: `task ${id}`,
  summary: `summary ${id}`,
  status: 'done',
  startedAt: at(8, 9),
  steps: [],
  ...extra,
})

describe('rotation timing', () => {
  it('turns over at the first moment after 04:00', () => {
    expect(lastBoundary(at(8, 10))).toBe(at(8, 4))
    expect(lastBoundary(at(8, 3))).toBe(at(7, 4))
  })
  it('is due for a session from before the latest boundary only', () => {
    expect(rotationDue(at(7, 22), at(8, 9))).toBe(true)
    expect(rotationDue(at(8, 5), at(8, 23))).toBe(false)
    // Still the same "day" until 04:00: no rotation at midnight.
    expect(rotationDue(at(7, 22), at(8, 2))).toBe(false)
    expect(rotationDue(undefined, at(8, 9))).toBe(false)
  })
})

describe('buildSessionSeed', () => {
  it('carries the end of the thread and the latest tasks with their ids', () => {
    const seed = buildSessionSeed(
      [msg('user', '帮我订周五去杭州的票', at(7, 20)), msg('assistant', '好，我去看看。', at(7, 20, 1)), msg('assistant', '', at(7, 20, 2), { approval: { id: 'a', title: 't', detail: 'd', icon: 'globe' } })],
      [activity('t1', { title: '查杭州车票', summary: 'G7 次 9:00' })],
    )
    expect(seed).toContain('User: 帮我订周五去杭州的票')
    expect(seed).toContain('You: 好，我去看看。')
    expect(seed).toContain('- t1 · done · 查杭州车票 — G7 次 9:00')
    expect(seed.match(/\[Oct/g)).toHaveLength(2)
  })
  it('keeps only the most recent messages, newest kept when trimming', () => {
    const many = Array.from({ length: 50 }, (_, i) => msg('user', `m${i}`, at(7, 10, i)))
    const seed = buildSessionSeed(many, [])
    expect(seed).toContain('m49')
    expect(seed).not.toContain('m29:')
    expect(seed).not.toContain('User: m29')
  })
  it('is empty for an empty thread', () => {
    expect(buildSessionSeed([], [])).toBe('')
  })
})

describe('buildWrapUpTranscript', () => {
  it('interleaves what was said with what finished tasks produced, skipping stopped ones', () => {
    const text = buildWrapUpTranscript(
      [msg('user', '我下周二面试', at(7, 9)), msg('assistant', '祝顺利', at(7, 9, 1))],
      [activity('x', { title: '查公司', report: '一家做芯片的公司', finishedAt: at(7, 9, 30) }), activity('y', { status: 'stopped', finishedAt: at(7, 10) })],
    )
    const lines = text.split('\n')
    expect(lines[0]).toContain('User: 我下周二面试')
    expect(lines[2]).toContain('Task "查公司" (done): 一家做芯片的公司')
    expect(text).not.toContain('task y')
  })
})

describe('ContextReminder', () => {
  function setup() {
    let now = at(8, 9)
    const files: ProfileFile[] = [
      { name: 'memory', content: '# About the user', updatedAt: 1, updatedBy: 'assistant' },
      { name: 'soul', content: '# Soul', updatedAt: 1, updatedBy: 'user' },
    ]
    const reminder = new ContextReminder(() => files, () => now)
    return { reminder, files, tick: (ms: number) => (now += ms) }
  }

  it('tells the time at the first turn, then only every so often', () => {
    const { reminder, tick } = setup()
    expect(reminder.next()).toContain('It is now Thursday, October 8, 2026')
    tick(5 * 60_000)
    expect(reminder.next()).toBeNull()
    tick(15 * 60_000)
    expect(reminder.next()).toContain('It is now')
  })

  it("passes on someone else's edit to memory.md once, with the new content", () => {
    const { reminder, files } = setup()
    reminder.next()
    files[0] = { ...files[0]!, content: '# About the user\n- 喜欢蓝色', updatedAt: 2, updatedBy: 'user' }
    const note = reminder.next()
    expect(note).toContain('memory.md was just changed by the user')
    expect(note).toContain('- 喜欢蓝色')
    expect(reminder.next()).toBeNull()
  })

  it("does not echo the main agent's own edit, nor files outside its reminders", () => {
    const { reminder, files } = setup()
    reminder.next()
    files[0] = { ...files[0]!, updatedAt: 3 }
    reminder.mark('memory')
    files[2] = { ...files[2]!, updatedAt: 3 }
    expect(reminder.next()).toBeNull()
  })
})
