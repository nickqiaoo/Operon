import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { it, expect } from 'vitest'
import { installExternalAgentSkill } from './external-agent-skill.js'

it('installs the external-agent skill idempotently and preserves a user-owned copy', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'external-skill-'))
  try {
    const userFile = path.join(homeDir, '.claude/skills/operon-external-agent/SKILL.md')
    await mkdir(path.dirname(userFile), { recursive: true })
    await writeFile(userFile, 'User instructions')
    const first = await installExternalAgentSkill({ homeDir })
    expect(first.installed).toHaveLength(2)
    expect(first.skipped).toContain(userFile)
    const second = await installExternalAgentSkill({ homeDir })
    expect(second.unchanged).toEqual(first.installed)
    expect(await readFile(userFile, 'utf8')).toBe('User instructions')
  } finally { await rm(homeDir, { recursive: true, force: true }) }
})
