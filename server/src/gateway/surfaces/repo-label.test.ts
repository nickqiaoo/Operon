import { describe, expect, it } from 'vitest'
import { repoFromLabels } from './linear-mapping.js'

describe('repoFromLabels', () => {
  it('reads the one repo: label, case-insensitively', () => {
    expect(repoFromLabels(['Bug', 'Repo:Acme/App'])).toEqual({ repo: 'acme/app' })
    expect(repoFromLabels([' repo:acme/app '])).toEqual({ repo: 'acme/app' })
  })
  it('is none without a repo: label', () => {
    expect(repoFromLabels(['Bug', 'repository:acme/app'])).toEqual({ error: 'none', labels: [] })
  })
  it('refuses two different repositories', () => {
    const r = repoFromLabels(['repo:acme/app', 'repo:acme/web'])
    expect(r).toMatchObject({ error: 'ambiguous' })
  })
  it('tolerates the same repository labelled twice', () => {
    expect(repoFromLabels(['repo:acme/app', 'REPO:acme/app'])).toEqual({ repo: 'acme/app' })
  })
  it('rejects labels that are not owner/name', () => {
    expect(repoFromLabels(['repo:acme'])).toMatchObject({ error: 'invalid' })
    expect(repoFromLabels(['repo:https://github.com/acme/app'])).toMatchObject({ error: 'invalid' })
  })
})
