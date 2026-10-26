import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE_FILES } from './defaults.js'
import { heartbeatChecks, heartbeatTold, withHeartbeatTold } from '../../../../shared/assistant.js'
import { cadenceOf, heartbeatHasWork, inQuietHours } from './schedule.js'
import { buildHeartbeatInstructions, buildHeartbeatPrompt } from './prompts.js'

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
  const checklist = DEFAULT_PROFILE_FILES.heartbeat
  it('skips when there is nothing to do: both templates alone, the example commented out', () => {
    expect(heartbeatHasWork(memory, checklist)).toBe(false)
  })
  it('runs for a check in heartbeat.md, or something in progress', () => {
    expect(heartbeatHasWork(memory, `${checklist}\n## Grafana\n- Call list_alert_rules\n`)).toBe(true)
    expect(heartbeatHasWork(memory.replace('# In progress\n', '# In progress\n- 10-09 面试\n'), checklist)).toBe(true)
  })
  it('does not count list items under other headings as in progress', () => {
    expect(heartbeatHasWork(memory.replace('# People\n', '# People\n- 小王：同事\n'), checklist)).toBe(false)
  })
})

describe('heartbeatChecks', () => {
  it('lists the sections by heading, outside comments', () => {
    expect(heartbeatChecks('# Heartbeat\n<!--\n## Example\n-->\n## Grafana\n- x\n## PostHog errors\n- y\n')).toEqual(['Grafana', 'PostHog errors'])
    expect(heartbeatChecks('<!-- unclosed\n## Example\n')).toEqual([])
  })
})

describe('the heartbeat\'s "Already told" section', () => {
  const checklist = '# Heartbeat\n\n## Grafana\n- list alerts\n'

  it('is not a check', () => {
    expect(heartbeatChecks(`${checklist}\n## Already told\n\n- Saturation critical on broker-host, since Oct 13 16:22\n`)).toEqual(['Grafana'])
  })

  it('is added at the end, and replaced in place without touching the checklist', () => {
    const once = withHeartbeatTold(checklist, '- Saturation critical on broker-host, since Oct 13 16:22')
    expect(once).toBe('# Heartbeat\n\n## Grafana\n- list alerts\n\n## Already told\n\n- Saturation critical on broker-host, since Oct 13 16:22\n')
    expect(heartbeatTold(once)).toBe('- Saturation critical on broker-host, since Oct 13 16:22')

    // A section the user (or the assistant) added below it meanwhile stays, and so does its own text.
    const edited = `${once}\n## PostHog\n- errors\n`
    const twice = withHeartbeatTold(edited, '- PostHog: TypeError in checkout, first seen Oct 15 09:10\n\n### Later\n- Invoice due Friday')
    expect(heartbeatChecks(twice)).toEqual(['Grafana', 'PostHog'])
    expect(twice).toContain('## PostHog\n- errors')
    expect(heartbeatTold(twice)).toBe('- PostHog: TypeError in checkout, first seen Oct 15 09:10\n\n### Later\n- Invoice due Friday')
    expect(twice).not.toContain('Saturation')
  })

  it('goes away when nothing told is still so', () => {
    expect(withHeartbeatTold(withHeartbeatTold(checklist, '- x'), '')).toBe(checklist)
    expect(heartbeatTold(checklist)).toBe('')
  })

  it('stays one section when told comes back with its own heading', () => {
    const once = withHeartbeatTold(checklist, '## Already told\n\n- Saturation critical on broker-host')
    expect(once).toBe('# Heartbeat\n\n## Grafana\n- list alerts\n\n## Already told\n\n- Saturation critical on broker-host\n')
    expect(heartbeatTold(once)).toBe('- Saturation critical on broker-host')
  })

  it('reads every stacked-up section, and writes them back as one in place of the first', () => {
    const stacked = `${checklist}\n## Already told\n\n## Already told\n- 11:30 still firing\n\n## Already told\n\n- 10:30 still firing\n\n## PostHog\n- errors\n`
    expect(heartbeatTold(stacked)).toBe('- 11:30 still firing\n\n- 10:30 still firing')
    expect(heartbeatChecks(stacked)).toEqual(['Grafana', 'PostHog'])

    const merged = withHeartbeatTold(stacked, '- 12:00 still firing')
    expect(merged).toBe('# Heartbeat\n\n## Grafana\n- list alerts\n\n## Already told\n\n- 12:00 still firing\n\n## PostHog\n- errors\n')
    expect(withHeartbeatTold(stacked, '')).toBe(`${checklist}\n## PostHog\n- errors\n`)
  })
})

describe('buildHeartbeatPrompt', () => {
  it('says when the last finished check was and whether it is quiet hours', () => {
    const quiet = buildHeartbeatPrompt(new Date(2026, 9, 15, 2, 0).getTime(), { start: '23:00', end: '08:00' })
    expect(quiet).toMatch(/Last completed check: Oct 15, 02:00/)
    expect(quiet).toContain('quiet hours (23:00–08:00)')
    expect(buildHeartbeatPrompt(undefined)).toContain('none — this is the first one')
    expect(buildHeartbeatPrompt(undefined)).toContain('not quiet hours')
  })
})

describe('buildHeartbeatInstructions', () => {
  const files = Object.fromEntries(
    Object.entries(DEFAULT_PROFILE_FILES).map(([name, content]) => [name, { name, content, updatedAt: 0, updatedBy: 'user' }]),
  ) as Parameters<typeof buildHeartbeatInstructions>[0]

  it('keeps an ending quiet unless the checklist asks to hear it, and then says it once', () => {
    const instructions = buildHeartbeatInstructions(files, [])
    expect(instructions).toContain('Something ending is not news')
    expect(instructions).toContain('dropped from told, not reported')
    expect(instructions).toContain('only when its checklist section explicitly asks to hear it, and only once')
  })
})
