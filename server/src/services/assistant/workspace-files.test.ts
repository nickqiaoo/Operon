import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-home-'))
vi.stubEnv('OPERON_ASSISTANT_DIR', home)
const { assistantRootOf, listOutputFiles, resolveAssistantPath } = await import('./workspace-files.js')

const workspace = path.join(home, 'workspace')
const write = (rel: string, mtime: number) => {
  const full = path.join(workspace, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, rel)
  fs.utimesSync(full, mtime, mtime)
}

beforeAll(() => {
  write('outputs/哈尔滨攻略.md', 3000)
  write('outputs/trips/beijing/expenses.csv', 2000)
  write('outputs/.DS_Store', 4000)
  write('scratch/apply.py', 5000)
  write('哈尔滨攻略.md', 1000)
  fs.writeFileSync(path.join(home, 'memory.md'), '')
})

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('listOutputFiles', () => {
  it('lists the outputs folder only, newest first, without dotfiles', async () => {
    const files = await listOutputFiles()
    expect(files.map((f) => f.relativePath)).toEqual(['哈尔滨攻略.md', 'trips/beijing/expenses.csv'])
    expect(files[0]).toMatchObject({ path: path.join(workspace, 'outputs/哈尔滨攻略.md'), updatedAt: 3_000_000 })
  })
})

describe('resolveAssistantPath', () => {
  it('reads relative paths from the workspace, then from its home', async () => {
    expect(await resolveAssistantPath('哈尔滨攻略.md')).toBe(path.join(workspace, '哈尔滨攻略.md'))
    expect(await resolveAssistantPath('workspace/outputs/trips/beijing/expenses.csv')).toBe(path.join(workspace, 'outputs/trips/beijing/expenses.csv'))
    expect(await resolveAssistantPath('memory.md')).toBe(path.join(home, 'memory.md'))
  })
  it('takes absolute paths as they are, and nothing that is not a file', async () => {
    expect(await resolveAssistantPath(path.join(workspace, '哈尔滨攻略.md'))).toBe(path.join(workspace, '哈尔滨攻略.md'))
    expect(await resolveAssistantPath('trips')).toBeNull()
    expect(await resolveAssistantPath('missing.md')).toBeNull()
    expect(await resolveAssistantPath('  ')).toBeNull()
  })
})

describe('assistantRootOf', () => {
  it('picks the workspace over its home, and nothing outside both', () => {
    expect(assistantRootOf(path.join(workspace, 'a.md'))).toBe(workspace)
    expect(assistantRootOf(path.join(home, 'memory.md'))).toBe(home)
    expect(assistantRootOf('/etc/hosts')).toBeNull()
  })
})
