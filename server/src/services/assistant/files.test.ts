import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE_FILES } from './defaults.js'
import { addedFacts, addToInProgress } from './files.js'

describe('addToInProgress', () => {
  it('appends to the end of the section, before the next heading', () => {
    const memory = '# People\n- 小王\n\n# In progress\n- 10-09 面试\n\n# Preferences\n- 简短\n'
    expect(addToInProgress(memory, ['- 留意放票 until 2026-10-03'])).toBe(
      '# People\n- 小王\n\n# In progress\n- 10-09 面试\n- 留意放票 until 2026-10-03\n\n# Preferences\n- 简短\n',
    )
  })
  it('fills the empty section of the template', () => {
    expect(addToInProgress(DEFAULT_PROFILE_FILES.memory, ['- a'])).toBe(DEFAULT_PROFILE_FILES.memory.replace('# In progress\n', '# In progress\n- a\n'))
  })
  it('adds the section when memory.md has none', () => {
    expect(addToInProgress('# People\n', ['- a'])).toBe('# People\n\n# In progress\n- a\n')
  })
})

describe('addedFacts', () => {
  it('reads what an edit added as the user would: no bullet, no date', () => {
    const before = '# About the user\n- 2026-10-11：用 Grafana Cloud 监控 Operon Broker\n\n# People\n'
    const after = '# About the user\n- 2026-10-11：用 Grafana Cloud 监控 Operon Broker\n- 2026-10-12: 开特斯拉 Model 3\n\n# People\n* 老婆：小李\n'
    expect(addedFacts(before, after)).toEqual(['开特斯拉 Model 3', '老婆：小李'])
  })
  it('ignores headings, removals and lines merely moved', () => {
    expect(addedFacts('# A\n- x\n- y\n', '# B\n- y\n- x\n')).toEqual([])
    expect(addedFacts('- x\n- y\n', '- x\n')).toEqual([])
  })
})
