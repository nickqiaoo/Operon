import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-days-'))
process.env.OPERON_ASSISTANT_DIR = dir
const { appendDay, isDayDate, listDays, localDate, readDay } = await import('./days.js')
const { callAssistantTool } = await import('./tools.js')

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime()

beforeAll(() => fs.mkdirSync(dir, { recursive: true }))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('day notes', () => {
  it('accepts only real dates', () => {
    expect(isDayDate('2026-10-12')).toBe(true)
    expect(isDayDate('2026-02-30')).toBe(false)
    expect(isDayDate('Oct 12')).toBe(false)
  })

  it('starts a note with its date and weekday, then adds entries under the time', () => {
    appendDay('2026-10-10', '- HSBC card 8651: three Alipay charges, CNY 21 / 2.3 / 8.12', at(10, 22, 53))
    appendDay('2026-10-10', '- Does not use Google Calendar', at(10, 23, 1))
    expect(readDay('2026-10-10')).toBe(
      '# 2026-10-10 (Saturday)\n\n## 22:53\n- HSBC card 8651: three Alipay charges, CNY 21 / 2.3 / 8.12\n\n## 23:01\n- Does not use Google Calendar\n',
    )
  })

  it('says when an entry about another day was added', () => {
    appendDay('2026-10-09', '- Interview went well', at(10, 9, 5))
    expect(readDay('2026-10-09')).toContain('## Added 2026-10-10 09:05\n- Interview went well')
  })

  it('lists days newest first and reads nothing for an empty day', () => {
    expect(listDays()).toEqual(['2026-10-10', '2026-10-09'])
    expect(readDay('2026-10-01')).toBeUndefined()
  })
})

describe('day_note / day_read tools', () => {
  const host = {} as Parameters<typeof callAssistantTool>[3]

  it('writes today by default and reads it back', async () => {
    expect(await callAssistantTool('day_note', { text: '- Set up the morning brief' }, { role: 'main' }, host)).toEqual({
      text: `Saved to the note for ${localDate()}.`,
    })
    const read = await callAssistantTool('day_read', { date: localDate() }, { role: 'main' }, host)
    expect(read.text).toContain('- Set up the morning brief')
  })

  it('refuses a bad or future date, and points an empty day at memory_search', async () => {
    expect((await callAssistantTool('day_note', { text: 'x', date: '2026-13-01' }, { role: 'main' }, host)).isError).toBe(true)
    expect((await callAssistantTool('day_note', { text: 'x', date: '2999-01-01' }, { role: 'main' }, host)).isError).toBe(true)
    expect((await callAssistantTool('day_read', { date: '2026-10-01' }, { role: 'main' }, host)).text).toBe(
      'Nothing was written down for 2026-10-01. Try memory_search.',
    )
  })

  it('is the main agent’s alone', async () => {
    expect((await callAssistantTool('day_note', { text: 'x' }, { role: 'worker', id: 'w1' }, host)).isError).toBe(true)
  })
})
