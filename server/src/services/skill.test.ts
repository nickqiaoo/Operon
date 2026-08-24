import { afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  installSkill,
  listInstalledSkills,
  listInstalledSkillsWithShadowing,
  removeSkill,
  updateSkill,
} from './skill.js'

const tempDirs: string[] = []

async function makeRoot(prefix = 'operon-skill-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A local directory that parses as a skill source: `<root>/skills/<name>/SKILL.md`. */
async function makeSource(name: string, body = 'original body'): Promise<string> {
  const root = await makeRoot('operon-skill-src-')
  const skillDir = path.join(root, 'skills', name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: a test skill\n---\n\n${body}\n`,
    'utf8',
  )
  await writeFile(path.join(skillDir, 'reference.md'), 'bundled asset', 'utf8')
  return root
}

async function rewriteSource(sourceRoot: string, name: string, body: string): Promise<void> {
  await writeFile(
    path.join(sourceRoot, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: a test skill\n---\n\n${body}\n`,
    'utf8',
  )
}

function readLock(root: string): Promise<string> {
  return readFile(path.join(root, '.agents', '.skill-lock.json'), 'utf8')
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('installSkill', () => {
  it('writes the canonical copy with its bundled files', async () => {
    const workspacePath = await makeRoot()
    const source = await makeSource('demo')

    const result = await installSkill(source, 'demo', { scope: 'project', workspacePath })

    const canonical = path.join(workspacePath, '.agents', 'skills', 'demo')
    expect(await readFile(path.join(canonical, 'SKILL.md'), 'utf8')).toContain('original body')
    expect(await readFile(path.join(canonical, 'reference.md'), 'utf8')).toBe('bundled asset')
    expect(result.targets).toHaveLength(1)
    expect(result.targets[0]!.method).toBe('canonical')
  })

  it('fans out to every detected agent so they all see the skill', async () => {
    const workspacePath = await makeRoot()
    await mkdir(path.join(workspacePath, '.claude'), { recursive: true })
    const source = await makeSource('demo')

    const result = await installSkill(source, 'demo', { scope: 'project', workspacePath })

    // The bug this fixes: a marketplace install used to land in .agents/skills only,
    // leaving Claude Code sessions unable to see it.
    expect(await readFile(path.join(workspacePath, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf8')).toContain(
      'original body',
    )
    expect(result.targets.map((t) => t.method)).toEqual(['canonical', 'copy'])
  })

  it('records provenance so the list can show where a skill came from', async () => {
    const workspacePath = await makeRoot()
    const source = await makeSource('demo')

    await installSkill(source, 'demo', { scope: 'project', workspacePath })

    const lock = JSON.parse(await readLock(workspacePath))
    expect(lock.version).toBe(4)
    expect(lock.skills.demo.sourceType).toBe('local')
    expect(lock.skills.demo.skillFolderHash).toMatch(/^[a-f0-9]{64}$/)
    expect(lock.skills.demo.targets).toEqual(['agents'])
    expect(lock.skills.demo.installedAt).toBeTruthy()
  })

  it('rejects a skill missing from the source', async () => {
    const workspacePath = await makeRoot()
    const source = await makeSource('demo')

    await expect(installSkill(source, 'nope', { scope: 'project', workspacePath })).rejects.toThrow(
      /not found in source/,
    )
  })

  it('refuses git transports that would execute a command', async () => {
    const workspacePath = await makeRoot()

    // `ext::` runs an arbitrary shell command during clone.
    await expect(
      installSkill('ext::sh -c touch% /tmp/pwned', 'demo', { scope: 'project', workspacePath }),
    ).rejects.toThrow(/Unsupported skill source/)
  })
})

describe('listInstalledSkills', () => {
  it('reports one row per skill, crediting every agent that can see it', async () => {
    const workspacePath = await makeRoot()
    await mkdir(path.join(workspacePath, '.claude'), { recursive: true })
    const source = await makeSource('demo')
    await installSkill(source, 'demo', { scope: 'project', workspacePath })

    const skills = await listInstalledSkills({ scope: 'project', workspacePath })

    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('demo')
    expect(skills[0]!.description).toBe('a test skill')
    expect(skills[0]!.scope).toBe('project')
    expect(skills[0]!.agents).toEqual(expect.arrayContaining(['operon', 'claude']))
  })

  it('joins the lock file so each row carries its source', async () => {
    const workspacePath = await makeRoot()
    const source = await makeSource('demo')
    await installSkill(source, 'demo', { scope: 'project', workspacePath })

    const [skill] = await listInstalledSkills({ scope: 'project', workspacePath })

    expect(skill!.source).toBe(source)
    expect(skill!.installedAt).toBeTruthy()
    expect(skill!.updatedAt).toBeTruthy()
  })

  it('lists hand-placed skills that have no install record', async () => {
    const workspacePath = await makeRoot()
    const manual = path.join(workspacePath, '.agents', 'skills', 'handmade')
    await mkdir(manual, { recursive: true })
    await writeFile(path.join(manual, 'SKILL.md'), '---\nname: handmade\ndescription: mine\n---\n', 'utf8')

    const [skill] = await listInstalledSkills({ scope: 'project', workspacePath })

    expect(skill!.name).toBe('handmade')
    expect(skill!.source).toBeUndefined()
  })

  it('returns nothing for a workspace with no skills', async () => {
    const workspacePath = await makeRoot()

    expect(await listInstalledSkills({ scope: 'project', workspacePath })).toEqual([])
  })
})

describe('listInstalledSkillsWithShadowing', () => {
  it('flags global skills that a project copy overrides', async () => {
    const homeDir = await makeRoot('operon-skill-home-')
    const workspacePath = await makeRoot()
    const source = await makeSource('demo')
    const other = await makeSource('solo')

    await installSkill(source, 'demo', { scope: 'global', homeDir })
    await installSkill(other, 'solo', { scope: 'global', homeDir })
    await installSkill(source, 'demo', { scope: 'project', workspacePath })

    const skills = await listInstalledSkillsWithShadowing('global', workspacePath, homeDir)

    // Agents scan project directories first, so the global "demo" never loads.
    expect(skills.find((s) => s.name === 'demo')!.shadowed).toBe(true)
    expect(skills.find((s) => s.name === 'solo')!.shadowed).toBeUndefined()
  })

  it('leaves everything unflagged when no project is open', async () => {
    const homeDir = await makeRoot('operon-skill-home-')
    const source = await makeSource('demo')
    await installSkill(source, 'demo', { scope: 'global', homeDir })

    const skills = await listInstalledSkillsWithShadowing('global', undefined, homeDir)

    expect(skills[0]!.shadowed).toBeUndefined()
  })
})

describe('updateSkill', () => {
  it('re-fetches when the source moved on', async () => {
    const workspacePath = await makeRoot()
    const source = await makeSource('demo')
    await installSkill(source, 'demo', { scope: 'project', workspacePath })

    await rewriteSource(source, 'demo', 'upstream rewrote this')
    const result = await updateSkill('demo', { scope: 'project', workspacePath })

    expect(result.needsForce).toBeUndefined()
    expect(
      await readFile(path.join(workspacePath, '.agents', 'skills', 'demo', 'SKILL.md'), 'utf8'),
    ).toContain('upstream rewrote this')
  })

  it('reports a no-op when the source is unchanged', async () => {
    const workspacePath = await makeRoot()
    const source = await makeSource('demo')
    await installSkill(source, 'demo', { scope: 'project', workspacePath })

    const result = await updateSkill('demo', { scope: 'project', workspacePath })

    expect(result.message).toMatch(/already up to date/)
  })

  it('refuses to silently discard local edits', async () => {
    const workspacePath = await makeRoot()
    const source = await makeSource('demo')
    await installSkill(source, 'demo', { scope: 'project', workspacePath })

    const installedFile = path.join(workspacePath, '.agents', 'skills', 'demo', 'SKILL.md')
    await writeFile(installedFile, '---\nname: demo\ndescription: a test skill\n---\n\nmy own tweaks\n', 'utf8')
    await rewriteSource(source, 'demo', 'upstream rewrote this')

    const result = await updateSkill('demo', { scope: 'project', workspacePath })

    expect(result.needsForce).toBe(true)
    // The edit must survive a refused update.
    expect(await readFile(installedFile, 'utf8')).toContain('my own tweaks')
  })

  it('overwrites local edits once forced', async () => {
    const workspacePath = await makeRoot()
    const source = await makeSource('demo')
    await installSkill(source, 'demo', { scope: 'project', workspacePath })

    const installedFile = path.join(workspacePath, '.agents', 'skills', 'demo', 'SKILL.md')
    await writeFile(installedFile, 'my own tweaks', 'utf8')
    await rewriteSource(source, 'demo', 'upstream rewrote this')

    const result = await updateSkill('demo', { scope: 'project', workspacePath }, true)

    expect(result.needsForce).toBeUndefined()
    expect(await readFile(installedFile, 'utf8')).toContain('upstream rewrote this')
  })

  it('explains why a hand-placed skill cannot be updated', async () => {
    const workspacePath = await makeRoot()
    const manual = path.join(workspacePath, '.agents', 'skills', 'handmade')
    await mkdir(manual, { recursive: true })
    await writeFile(path.join(manual, 'SKILL.md'), '---\nname: handmade\ndescription: mine\n---\n', 'utf8')

    await expect(updateSkill('handmade', { scope: 'project', workspacePath })).rejects.toThrow(
      /installed outside Operon/,
    )
  })
})

describe('removeSkill', () => {
  it('clears every directory, not just the canonical one', async () => {
    const workspacePath = await makeRoot()
    await mkdir(path.join(workspacePath, '.claude'), { recursive: true })
    const source = await makeSource('demo')
    await installSkill(source, 'demo', { scope: 'project', workspacePath })

    await removeSkill('demo', { scope: 'project', workspacePath })

    // A copy left behind in one agent's directory keeps advertising a removed skill.
    await expect(lstat(path.join(workspacePath, '.agents', 'skills', 'demo'))).rejects.toThrow()
    await expect(lstat(path.join(workspacePath, '.claude', 'skills', 'demo'))).rejects.toThrow()
  })

  it('drops the lock entry too', async () => {
    const workspacePath = await makeRoot()
    const source = await makeSource('demo')
    await installSkill(source, 'demo', { scope: 'project', workspacePath })

    await removeSkill('demo', { scope: 'project', workspacePath })

    expect(JSON.parse(await readLock(workspacePath)).skills).toEqual({})
  })

  it('reports an unknown skill instead of silently succeeding', async () => {
    const workspacePath = await makeRoot()

    await expect(removeSkill('ghost', { scope: 'project', workspacePath })).rejects.toThrow(/not found/)
  })
})
