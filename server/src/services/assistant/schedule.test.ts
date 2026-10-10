import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE_FILES } from './defaults.js'
import { cadenceOf, heartbeatHasWork, inQuietHours, removeLines } from './schedule.js'
import { buildHeartbeatPrompt } from './prompts.js'

const daily = (time: string, days: number[]) => ({ type: 'daily' as const, time, days })

describe('cadenceOf', () => {
  it('reads like a person would say it', () => {
    expect(cadenceOf({ ...daily('00:00', [0, 1, 2, 3, 4, 5, 6]), intervalMinutes: 30, endTime: '23:59' })).toBe('Every 30 minutes')
    expect(cadenceOf(daily('08:40', [0, 1, 2, 3, 4, 5, 6]))).toBe('Daily at 08:40')
    expect(cadenceOf(daily('08:40', [1, 2, 3, 4, 5]))).toBe('Weekdays at 08:40')
    expect(cadenceOf(daily('10:00', [0, 6]))).toBe('Weekends at 10:00')
    expect(cadenceOf(daily('09:00', [1, 3]))).toBe('Mon, Wed at 09:00')
    expect(cadenceOf({ ...daily('09:00', [1, 2, 3, 4, 5]), intervalMinutes: 120, endTime: '18:00' })).toBe('Every 2 hours, 09:00–18:00 on weekdays')
  })
})

describe('inQuietHours', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 8, h, m)
  it('handles a window across midnight', () => {
    expect(inQuietHours(at(23, 30), '23:00', '08:00')).toBe(true)
    expect(inQuietHours(at(3), '23:00', '08:00')).toBe(true)
    expect(inQuietHours(at(8), '23:00', '08:00')).toBe(false)
    expect(inQuietHours(at(14), '23:00', '08:00')).toBe(false)
  })
  it('handles a window within a day, and treats an empty one as off', () => {
    expect(inQuietHours(at(13), '12:00', '14:00')).toBe(true)
    expect(inQuietHours(at(15), '12:00', '14:00')).toBe(false)
    expect(inQuietHours(at(15), '08:00', '08:00')).toBe(false)
  })
})

describe('heartbeatHasWork', () => {
  const memory = DEFAULT_PROFILE_FILES.memory
  const heartbeat = DEFAULT_PROFILE_FILES.heartbeat
  it('skips when there is nothing to look at: the templates alone, no services', () => {
    expect(heartbeatHasWork(heartbeat, memory, [])).toBe(false)
  })
  it('runs for a connected service, a watch item, or something in progress', () => {
    expect(heartbeatHasWork(heartbeat, memory, ['gmail'])).toBe(true)
    expect(heartbeatHasWork(`${heartbeat}- 留意 12306 放票 until 2026-10-03\n`, memory, [])).toBe(true)
    expect(heartbeatHasWork(heartbeat, memory.replace('# In progress\n', '# In progress\n- 10-09 面试\n'), [])).toBe(true)
  })
  it('does not count list items under other headings as in progress', () => {
    expect(heartbeatHasWork(heartbeat, memory.replace('# People\n', '# People\n- 小王：同事\n'), [])).toBe(false)
  })
})

describe('removeLines', () => {
  it('drops exactly the expired lines', () => {
    const content = '# Heartbeat\n- a until 2026-10-01\n- b\n'
    expect(removeLines(content, ['- a until 2026-10-01'])).toBe('# Heartbeat\n- b\n')
    expect(removeLines(content, [])).toBe(content)
  })
})

describe('buildHeartbeatPrompt', () => {
  it('lists what is held for after quiet hours, so the check does not find it again', () => {
    const prompt = buildHeartbeatPrompt(undefined, [{ at: 1, text: 'PR merged' }], [{ at: 2, text: 'Invoice due Friday' }])
    expect(prompt).toContain('PR merged')
    expect(prompt).toMatch(/quiet hours end \(don't repeat\):\n.*Invoice due Friday/)
    expect(buildHeartbeatPrompt(undefined, [])).not.toContain('quiet hours')
  })
})
