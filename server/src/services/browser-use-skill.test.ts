import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installBrowserUseSkill, uninstallBrowserUseSkill } from './browser-use-skill.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'operon-browser-skill-'))
  tempDirs.push(dir)
  return dir
}

describe('installBrowserUseSkill', () => {
  it('installs the managed skill for universal agents, Grok, and Claude Code', async () => {
    const homeDir = await tempHome()
    const result = await installBrowserUseSkill({ homeDir })

    const agentsSkill = path.join(homeDir, '.agents/skills/operon-browser-use/SKILL.md')
    const grokSkill = path.join(homeDir, '.grok/skills/operon-browser-use/SKILL.md')
    const claudeSkill = path.join(homeDir, '.claude/skills/operon-browser-use/SKILL.md')
    expect(result.installed).toEqual([agentsSkill, grokSkill, claudeSkill])
    await expect(readFile(agentsSkill, 'utf8')).resolves.toContain('name: operon-browser-use')
    await expect(readFile(grokSkill, 'utf8')).resolves.toContain('name: operon-browser-use')
    // Body marker, and the post-banner contract: the skill no longer teaches a
    // bootstrap, because `agent` is installed before the model's first line.
    await expect(readFile(claudeSkill, 'utf8')).resolves.toContain('`agent` is already installed')
    await expect(readFile(claudeSkill, 'utf8')).resolves.not.toContain('OPERON_BROWSER_CLIENT_PATH')

    const second = await installBrowserUseSkill({ homeDir })
    expect(second.unchanged).toEqual([agentsSkill, grokSkill, claudeSkill])
  })

  it('does not overwrite a user-authored skill with the same name', async () => {
    const homeDir = await tempHome()
    const target = path.join(homeDir, '.agents/skills/operon-browser-use/SKILL.md')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, '---\nname: operon-browser-use\n---\nUser owned.\n', 'utf8')

    const result = await installBrowserUseSkill({ homeDir })
    expect(result.skipped).toEqual([target])
    await expect(readFile(target, 'utf8')).resolves.toContain('User owned.')
  })

  it('requires complete browser documentation before the first interaction', async () => {
    const homeDir = await tempHome()
    await installBrowserUseSkill({ homeDir })
    const body = await readFile(
      path.join(homeDir, '.agents/skills/operon-browser-use/SKILL.md'),
      'utf8',
    )

    expect(body).toContain('nodeRepl.write(await iab.documentation());')
    expect(body).toContain('Only if the tool output itself explicitly reports that it')
    expect(body).toContain('read smaller chunks until you have read the documentation in')
    expect(body).toContain("Once you have read the browser's complete documentation")
    expect(body).toContain('do not read it')
    expect(body).toContain('A new user turn does not invalidate the browser')
    expect(body).toContain('or require another selection or documentation call')
  })
})

describe('uninstallBrowserUseSkill', () => {
  it('removes the managed skill so agents stop discovering it', async () => {
    const homeDir = await tempHome()
    const installed = await installBrowserUseSkill({ homeDir })

    const result = await uninstallBrowserUseSkill({ homeDir })
    expect(result.removed).toEqual(installed.installed)
    // The directory goes too — an empty operon-browser-use/ still lists in some runtimes.
    for (const file of installed.installed) {
      await expect(access(path.dirname(file))).rejects.toThrow()
    }
  })

  it('leaves a user-authored skill of the same name alone', async () => {
    const homeDir = await tempHome()
    const target = path.join(homeDir, '.agents/skills/operon-browser-use/SKILL.md')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, '---\nname: operon-browser-use\n---\nUser owned.\n', 'utf8')

    const result = await uninstallBrowserUseSkill({ homeDir })
    expect(result.removed).toEqual([])
    expect(result.skipped).toEqual([target])
    await expect(readFile(target, 'utf8')).resolves.toContain('User owned.')
  })

  it('is a no-op when nothing was ever installed', async () => {
    const homeDir = await tempHome()
    await expect(uninstallBrowserUseSkill({ homeDir })).resolves.toEqual({ removed: [], skipped: [] })
  })
})
