import { describe, expect, it } from 'vitest'
import { pageTaskText } from './task-board-service.js'

describe('pageTaskText', () => {
  it('returns a short task untouched', () => {
    const text = '# Task #3: hi\n\n## Description\nshort'
    expect(pageTaskText(text, 3)).toBe(text)
  })

  it('pages a long task with fixed line numbers, sections and the next offset', () => {
    const body = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`)
    const text = ['# Task #9: big', '', '## Description', ...body, '', '## Activity', '- user: go'].join('\n')

    const first = pageTaskText(text, 9)
    expect(first).toContain('1\t# Task #9: big')
    expect(first).toContain('Sections: Description L3, Activity L455')
    expect(first).toContain('get_project_task(task: 9, offset: 201)')

    const last = pageTaskText(text, 9, { offset: 401 })
    expect(last).toContain('456\t- user: go')
    expect(last).toContain('[End of task.]')
  })

  it('cuts one huge line so a page stays within its character budget', () => {
    const text = `## Description\n${'x'.repeat(30_000)}`
    const first = pageTaskText(text, 4)
    expect(first.length).toBeLessThan(14_000)
    expect(first).toContain('offset: ')
  })

  it('says so when the offset is past the end', () => {
    expect(pageTaskText(`a\n${'b'.repeat(13_000)}`, 4, { offset: 999 })).toContain('past the end')
  })
})
