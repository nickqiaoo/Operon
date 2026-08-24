import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installChromeUseSkill, uninstallChromeUseSkill } from './chrome-use-skill.js'
import { installBrowserUseSkill } from './browser-use-skill.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'operon-chrome-skill-'))
  tempDirs.push(dir)
  return dir
}

const readSkill = (homeDir: string) =>
  readFile(path.join(homeDir, '.agents/skills/operon-chrome/SKILL.md'), 'utf8')

describe('installChromeUseSkill', () => {
  it('installs for universal agents, Grok, and Claude Code', async () => {
    const homeDir = await tempHome()
    const result = await installChromeUseSkill({ homeDir })

    expect(result.installed).toEqual([
      path.join(homeDir, '.agents/skills/operon-chrome/SKILL.md'),
      path.join(homeDir, '.grok/skills/operon-chrome/SKILL.md'),
      path.join(homeDir, '.claude/skills/operon-chrome/SKILL.md'),
    ])
    await expect(readSkill(homeDir)).resolves.toContain('name: operon-chrome')

    const second = await installChromeUseSkill({ homeDir })
    expect(second.installed).toEqual([])
    expect(second.unchanged).toHaveLength(3)
  })

  it('uses the selector from the current official Chrome skill', async () => {
    // The current official skill explicitly selects Chrome with "extension". The client also
    // accepts the model-facing "chrome" alias, but the managed skill should follow that contract.
    const homeDir = await tempHome()
    await installChromeUseSkill({ homeDir })
    const body = await readSkill(homeDir)

    expect(body).toContain('agent.browsers.get("extension")')
    expect(body).toContain('`"chrome"` remains a compatibility alias')
  })

  it('requires complete Chrome documentation before the first interaction', async () => {
    const homeDir = await tempHome()
    await installChromeUseSkill({ homeDir })
    const body = await readSkill(homeDir)

    expect(body).toContain('nodeRepl.write(await chrome.documentation());')
    expect(body).toContain('Only if the tool output itself explicitly reports that it')
    expect(body).toContain('read smaller chunks until you have read the documentation in')
    expect(body).toContain("Once you have read Chrome's complete documentation")
    expect(body).toContain('do not read it')
    expect(body).toContain('A new user turn does not invalidate the browser')
    expect(body).toContain('or require another selection or documentation call')
  })

  it('tells the agent to stop rather than route around a missing extension', async () => {
    // Chrome can be unreachable for reasons the agent cannot fix. The failure mode we are
    // guarding against is it "helpfully" driving the browser via AppleScript instead.
    const homeDir = await tempHome()
    await installChromeUseSkill({ homeDir })
    const body = await readSkill(homeDir)

    expect(body).toContain('AppleScript')
    expect(body).toMatch(/Settings › Chrome/)
  })

  it('ships operon branding, not the vendored ChatGPT text', async () => {
    const homeDir = await tempHome()
    await installChromeUseSkill({ homeDir })
    const body = await readSkill(homeDir)

    expect(body).toContain('Operon')
    expect(body).not.toContain('ChatGPT Chrome Extension')
    expect(body).not.toContain('xui')
  })
})

describe('the chrome and browser skills are managed independently', () => {
  it('switching Chrome off leaves the in-app browser skill installed', async () => {
    // They are separate features with separate switches; per-skill markers are what keep one
    // uninstall from claiming the other's directory.
    const homeDir = await tempHome()
    await installBrowserUseSkill({ homeDir })
    await installChromeUseSkill({ homeDir })

    await uninstallChromeUseSkill({ homeDir })

    await expect(
      access(path.join(homeDir, '.agents/skills/operon-browser-use/SKILL.md')),
    ).resolves.toBeUndefined()
    await expect(
      access(path.join(homeDir, '.agents/skills/operon-chrome/SKILL.md')),
    ).rejects.toThrow()
  })
})

describe('uninstallChromeUseSkill', () => {
  it('removes the skill so agents stop discovering it', async () => {
    const homeDir = await tempHome()
    const installed = await installChromeUseSkill({ homeDir })

    const result = await uninstallChromeUseSkill({ homeDir })

    expect(result.removed).toEqual(installed.installed)
    for (const file of installed.installed) {
      await expect(access(path.dirname(file))).rejects.toThrow()
    }
  })

  it('is a no-op when nothing was ever installed', async () => {
    const homeDir = await tempHome()
    await expect(uninstallChromeUseSkill({ homeDir })).resolves.toEqual({ removed: [], skipped: [] })
  })
})
