import { describe, expect, it } from 'vitest'
import { matchGithubLink } from './github-links'

describe('matchGithubLink', () => {
  it('reads a pull request URL', () => {
    expect(matchGithubLink('https://github.com/nickqiaoo/operon-agents/pull/1')).toEqual({
      ref: { url: 'https://github.com/nickqiaoo/operon-agents/pull/1', owner: 'nickqiaoo', repo: 'operon-agents', kind: 'pull', number: 1 },
      rest: '',
    })
  })

  it('keeps CJK text an autolink swallowed as the rest', () => {
    expect(matchGithubLink('https://github.com/a/b/issues/3这个链接')?.rest).toBe('这个链接')
  })

  it('keeps sub-pages and fragments in the URL', () => {
    expect(matchGithubLink('https://github.com/a/b/pull/2/files#diff-1')?.ref.url).toBe('https://github.com/a/b/pull/2/files#diff-1')
  })

  it('rejects URLs that are not a PR or issue', () => {
    expect(matchGithubLink('https://github.com/a/b/tree/main')).toBeNull()
    expect(matchGithubLink('https://github.com/a/b/pull/2?diff=split')).toBeNull()
  })
})
