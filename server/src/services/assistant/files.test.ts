import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE_FILES } from './defaults.js'
import { addToInProgress } from './files.js'

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
