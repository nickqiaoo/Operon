import { describe, expect, it } from 'vitest'
import { parseIdentity } from '../../../../shared/assistant.js'
import { DEFAULT_PROFILE_FILES } from './defaults.js'

describe('parseIdentity', () => {
  it('reads an unnamed first-run identity as unset, not as the next line', () => {
    expect(parseIdentity(DEFAULT_PROFILE_FILES.identity)).toEqual({ name: undefined, userName: undefined })
  })

  it('reads both names', () => {
    expect(parseIdentity('---\nname: 小M\nuser_name: 乔乔\navatar: default\n---\n\nhi')).toEqual({ name: '小M', userName: '乔乔' })
  })

  it('ignores a file without frontmatter', () => {
    expect(parseIdentity('name: x')).toEqual({ name: undefined, userName: undefined })
  })
})
