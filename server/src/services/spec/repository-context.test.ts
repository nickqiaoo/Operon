import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect, it } from 'vitest'
import { readRecorded } from './repository-context.js'

it('reads existing project documentation without generating files', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-context-'))
  try {
    expect(await readRecorded(repo)).toBe('')
    expect(await fs.readdir(repo)).toEqual([])
    await fs.mkdir(path.join(repo, 'docs/adr'), { recursive: true })
    await fs.writeFile(path.join(repo, 'docs/adr/0001-first.md'), '# 0001. Notifications merge by source key\n')
    await fs.writeFile(path.join(repo, 'GLOSSARY.md'), '# Glossary\n- **Inbox**: notifications land here.\n')
    const context = await readRecorded(repo)
    expect(context).toContain('- 0001 Notifications merge by source key — `docs/adr/0001-first.md`')
    expect(context).toContain('**Inbox**')
    expect(await fs.readdir(path.join(repo, 'docs/adr'))).toEqual(['0001-first.md'])
  } finally {
    await fs.rm(repo, { recursive: true, force: true })
  }
})
