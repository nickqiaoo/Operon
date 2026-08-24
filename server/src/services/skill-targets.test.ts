import { afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  canonicalSkillsDir,
  linkIntoTarget,
  resolveExistingTargets,
  resolveInstallTargets,
} from './skill-targets.js'

const tempDirs: string[] = []

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'operon-skill-targets-'))
  tempDirs.push(dir)
  return dir
}

/** Create the marker directory that makes an agent count as "installed". */
async function installAgent(root: string, ...segments: string[]): Promise<void> {
  await mkdir(path.join(root, ...segments), { recursive: true })
}

async function makeSkill(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n\nbody\n`, 'utf8')
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('resolveInstallTargets — global', () => {
  it('always includes the canonical target, even on a bare home directory', async () => {
    const homeDir = await makeRoot()

    const targets = await resolveInstallTargets({ scope: 'global', homeDir })

    expect(targets).toHaveLength(1)
    expect(targets[0]!.id).toBe('agents')
    expect(targets[0]!.strategy).toBe('canonical')
    expect(targets[0]!.dir).toBe(path.join(homeDir, '.agents', 'skills'))
  })

  it('skips agents that are not installed', async () => {
    const homeDir = await makeRoot()
    await installAgent(homeDir, '.claude')

    const targets = await resolveInstallTargets({ scope: 'global', homeDir })

    expect(targets.map((t) => t.id)).toEqual(['agents', 'claude'])
    // Writing ~/.cursor on a machine without Cursor would just litter the home dir.
    expect(targets.map((t) => t.id)).not.toContain('cursor')
  })

  it('picks up every detected agent, including nested config roots', async () => {
    const homeDir = await makeRoot()
    await installAgent(homeDir, '.claude')
    await installAgent(homeDir, '.grok')
    await installAgent(homeDir, '.codex')
    await installAgent(homeDir, '.config', 'opencode')

    const targets = await resolveInstallTargets({ scope: 'global', homeDir })

    expect(targets.map((t) => t.id).sort()).toEqual(['agents', 'claude', 'codex', 'grok', 'opencode'])
    expect(targets.find((t) => t.id === 'opencode')!.dir).toBe(
      path.join(homeDir, '.config', 'opencode', 'skills'),
    )
  })

  it('gives Claude Code a real copy rather than a symlink', async () => {
    const homeDir = await makeRoot()
    await installAgent(homeDir, '.claude')
    await installAgent(homeDir, '.grok')

    const targets = await resolveInstallTargets({ scope: 'global', homeDir })

    expect(targets.find((t) => t.id === 'claude')!.strategy).toBe('copy')
    expect(targets.find((t) => t.id === 'grok')!.strategy).toBe('symlink')
  })
})

describe('resolveInstallTargets — project', () => {
  it('writes only the canonical directory in a fresh repository', async () => {
    const workspacePath = await makeRoot()

    const targets = await resolveInstallTargets({ scope: 'project', workspacePath })

    expect(targets).toHaveLength(1)
    expect(targets[0]!.dir).toBe(path.join(workspacePath, '.agents', 'skills'))
  })

  it('adds .claude/skills only when the repo already has a .claude directory', async () => {
    const workspacePath = await makeRoot()
    await installAgent(workspacePath, '.claude')

    const targets = await resolveInstallTargets({ scope: 'project', workspacePath })

    expect(targets.map((t) => t.dir)).toEqual([
      path.join(workspacePath, '.agents', 'skills'),
      path.join(workspacePath, '.claude', 'skills'),
    ])
  })

  it('folds agents that share .agents/skills into one target', async () => {
    const workspacePath = await makeRoot()

    const [canonical] = await resolveInstallTargets({ scope: 'project', workspacePath })

    // Codex, Cursor, Gemini and friends all read .agents/skills inside a project —
    // writing it once must still credit every one of them.
    expect(canonical!.agents).toEqual(
      expect.arrayContaining(['operon', 'codex', 'cursor', 'gemini', 'copilot']),
    )
  })

  it('refuses project scope without a workspace path', async () => {
    await expect(resolveInstallTargets({ scope: 'project' })).rejects.toThrow(/workspace path/i)
  })
})

describe('resolveExistingTargets', () => {
  it('lists a skills directory that exists, and omits the canonical one that does not', async () => {
    const homeDir = await makeRoot()
    await mkdir(path.join(homeDir, '.cursor', 'skills'), { recursive: true })

    const install = await resolveInstallTargets({ scope: 'global', homeDir })
    const existing = await resolveExistingTargets({ scope: 'global', homeDir })

    // Install always creates the canonical directory; listing must not invent it.
    expect(install.map((t) => t.id)).toContain('agents')
    expect(existing.map((t) => t.id)).toEqual(['cursor'])
  })

  it('ignores directories that do not exist', async () => {
    const homeDir = await makeRoot()

    expect(await resolveExistingTargets({ scope: 'global', homeDir })).toEqual([])
  })
})

describe('canonicalSkillsDir', () => {
  it('resolves per scope', async () => {
    const homeDir = await makeRoot()
    const workspacePath = await makeRoot()

    expect(canonicalSkillsDir({ scope: 'global', homeDir })).toBe(path.join(homeDir, '.agents', 'skills'))
    expect(canonicalSkillsDir({ scope: 'project', workspacePath })).toBe(
      path.join(workspacePath, '.agents', 'skills'),
    )
  })
})

describe('linkIntoTarget', () => {
  it('leaves the canonical target alone', async () => {
    const homeDir = await makeRoot()
    const canonicalDir = await makeSkill(path.join(homeDir, '.agents', 'skills', 'demo'), 'demo')
    const [canonical] = await resolveInstallTargets({ scope: 'global', homeDir })

    expect(await linkIntoTarget(canonicalDir, canonical!, 'demo')).toBe('canonical')
  })

  it('symlinks so one canonical edit reaches every agent', async () => {
    const homeDir = await makeRoot()
    await installAgent(homeDir, '.grok')
    const canonicalDir = await makeSkill(path.join(homeDir, '.agents', 'skills', 'demo'), 'demo')
    const targets = await resolveInstallTargets({ scope: 'global', homeDir })
    const grok = targets.find((t) => t.id === 'grok')!

    expect(await linkIntoTarget(canonicalDir, grok, 'demo')).toBe('symlink')

    const linked = path.join(grok.dir, 'demo')
    expect((await lstat(linked)).isSymbolicLink()).toBe(true)

    // The point of the symlink: updating the canonical copy updates the agent's view.
    await writeFile(path.join(canonicalDir, 'SKILL.md'), 'updated', 'utf8')
    expect(await readFile(path.join(linked, 'SKILL.md'), 'utf8')).toBe('updated')
  })

  it('copies for agents that do not follow symlinks', async () => {
    const homeDir = await makeRoot()
    await installAgent(homeDir, '.claude')
    const canonicalDir = await makeSkill(path.join(homeDir, '.agents', 'skills', 'demo'), 'demo')
    const targets = await resolveInstallTargets({ scope: 'global', homeDir })
    const claude = targets.find((t) => t.id === 'claude')!

    expect(await linkIntoTarget(canonicalDir, claude, 'demo')).toBe('copy')

    const copied = path.join(claude.dir, 'demo')
    expect((await lstat(copied)).isSymbolicLink()).toBe(false)
    expect(await readFile(path.join(copied, 'SKILL.md'), 'utf8')).toContain('name: demo')
  })

  it('replaces whatever was there before', async () => {
    const homeDir = await makeRoot()
    await installAgent(homeDir, '.claude')
    const canonicalDir = await makeSkill(path.join(homeDir, '.agents', 'skills', 'demo'), 'demo')
    const targets = await resolveInstallTargets({ scope: 'global', homeDir })
    const claude = targets.find((t) => t.id === 'claude')!

    // A stale copy from an older install, with a file the new version dropped.
    const stale = path.join(claude.dir, 'demo')
    await makeSkill(stale, 'demo')
    await writeFile(path.join(stale, 'old-asset.md'), 'stale', 'utf8')

    await linkIntoTarget(canonicalDir, claude, 'demo')

    await expect(lstat(path.join(stale, 'old-asset.md'))).rejects.toThrow()
  })
})
