import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installComputerUseSkill, uninstallComputerUseSkill } from './computer-use-skill.js'
import { installBrowserUseSkill, uninstallBrowserUseSkill } from './browser-use-skill.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'operon-computer-skill-'))
  tempDirs.push(dir)
  return dir
}

describe('installComputerUseSkill', () => {
  it('installs the managed skill for universal agents, Grok, and Claude Code', async () => {
    const homeDir = await tempHome()
    const result = await installComputerUseSkill({ homeDir })

    const agentsSkill = path.join(homeDir, '.agents/skills/operon-computer-use/SKILL.md')
    const grokSkill = path.join(homeDir, '.grok/skills/operon-computer-use/SKILL.md')
    const claudeSkill = path.join(homeDir, '.claude/skills/operon-computer-use/SKILL.md')
    expect(result.installed).toEqual([agentsSkill, grokSkill, claudeSkill])
    await expect(readFile(agentsSkill, 'utf8')).resolves.toContain('name: operon-computer-use')
    await expect(readFile(grokSkill, 'utf8')).resolves.toContain('name: operon-computer-use')

    const second = await installComputerUseSkill({ homeDir })
    expect(second.unchanged).toEqual([agentsSkill, grokSkill, claudeSkill])
  })

  it('ships operon branding, not the vendored ChatGPT text', async () => {
    // The skill started life as codex's verbatim copy, which told the agent it was
    // ChatGPT. Per project convention every user-visible string says operon.
    const homeDir = await tempHome()
    await installComputerUseSkill({ homeDir })
    const body = await readFile(path.join(homeDir, '.agents/skills/operon-computer-use/SKILL.md'), 'utf8')
    expect(body).toContain('Operon Computer Use')
    expect(body).not.toContain('ChatGPT interact')
    expect(body).not.toContain('xui')
  })

  it('describes the API the kernel actually exposes', async () => {
    // The client has no documentation() to defer to (unlike the browser client), so the skill
    // is the only spec the model gets. Snake_case names come from the client facade; the
    // camelCase MacComputerUseClient underneath is not what the model touches.
    const homeDir = await tempHome()
    await installComputerUseSkill({ homeDir })
    const body = await readFile(path.join(homeDir, '.agents/skills/operon-computer-use/SKILL.md'), 'utf8')
    for (const method of ['list_apps', 'get_app_state', 'click', 'type_text', 'press_key', 'set_value']) {
      expect(body).toContain(`computer.${method}`)
    }
    expect(body).toContain('element_index')
    expect(body).not.toContain('computer.getAppState')
  })

  it('covers the complete Codex Computer Use behavior surface', async () => {
    const homeDir = await tempHome()
    await installComputerUseSkill({ homeDir })
    const body = await readFile(path.join(homeDir, '.agents/skills/operon-computer-use/SKILL.md'), 'utf8')

    expect(body).toContain(
      'description: Control local Mac apps through Operon Computer Use for tasks that require reading or operating app UI. Prefer purpose-built connectors, APIs, or CLIs when available.',
    )
    expect(body).toContain('target: "mac"')
    // The bootstrap snippet is gone on purpose: the banner installs `computer`
    // before the model's first line, so a skill that still taught a setup guard
    // would be teaching a wasted turn. See packages/computer-use/banner.ts.
    expect(body).not.toContain('setupComputerUseRuntime')
    expect(body).not.toContain('OPERON_COMPUTER_USE_CLIENT_PATH')
    expect(body).toContain('`computer` is already installed')
    expect(body).toContain('node_repl` state is persistent across calls')
    expect(body).toContain('JSON.stringify(...)')
    expect(body).toContain('cannot invoke global shortcuts')
    expect(body).toContain('Do not call `list_apps` solely')
    expect(body).toContain("bundle identifier from `list_apps()`")
    expect(body).toContain('additional delays of up to 5 seconds')
    expect(body).toContain('always `file://` URLs')
    expect(body).toContain('Visiting a URL that embeds sensitive data also counts')
    expect(body).toContain('Vague asks')
    expect(body).toContain('expected taxes, mandatory fees, standard shipping')
  })

  it('teaches Codex-aligned text-first path and rare screenshot fallback', async () => {
    const homeDir = await tempHome()
    await installComputerUseSkill({ homeDir })
    const body = await readFile(path.join(homeDir, '.agents/skills/operon-computer-use/SKILL.md'), 'utf8')

    expect(body).toContain('Do not emit or read a screenshot merely to maintain that preview')
    expect(body).toContain('native Live preview (PiP)')
    expect(body).toContain('nodeRepl.write(state.text)')
    expect(body).toContain('pass true for disableDiff')
    // Rare fallback only — not the default monitoring path.
    expect(body).toContain('fileURLToPath(state.screenshot.url)')
  })
})

describe('uninstallComputerUseSkill', () => {
  it('removes the managed skill so agents stop discovering it', async () => {
    const homeDir = await tempHome()
    const installed = await installComputerUseSkill({ homeDir })

    const result = await uninstallComputerUseSkill({ homeDir })
    expect(result.removed).toEqual(installed.installed)
    for (const file of installed.installed) {
      await expect(access(path.dirname(file))).rejects.toThrow()
    }
  })

  it('is a no-op when nothing was ever installed', async () => {
    const homeDir = await tempHome()
    await expect(uninstallComputerUseSkill({ homeDir })).resolves.toEqual({ removed: [], skipped: [] })
  })
})

describe('the two skills are managed independently', () => {
  it('switching one off leaves the other installed', async () => {
    // Per-skill markers exist for exactly this: a shared marker would make either
    // uninstall claim both directories.
    const homeDir = await tempHome()
    await installBrowserUseSkill({ homeDir })
    await installComputerUseSkill({ homeDir })

    await uninstallComputerUseSkill({ homeDir })

    await expect(access(path.join(homeDir, '.agents/skills/operon-browser-use/SKILL.md'))).resolves.toBeUndefined()
    await expect(access(path.join(homeDir, '.agents/skills/operon-computer-use/SKILL.md'))).rejects.toThrow()

    await uninstallBrowserUseSkill({ homeDir })
    await expect(access(path.join(homeDir, '.agents/skills/operon-browser-use/SKILL.md'))).rejects.toThrow()
  })
})
