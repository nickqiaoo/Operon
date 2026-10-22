import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { writeSpecFiles } from './files.js'

vi.mock('../git.js', () => ({ commit: vi.fn(async () => undefined) }))

it('persists writes and deletions and stops before file changes if persistence fails', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'spec-artifacts-'))
  try {
    const artifacts: Record<string, string> = {}
    const storage = { specArtifactsWrite: vi.fn((_id: number, files: Record<string, string | null>) => {
      for (const [file, content] of Object.entries(files)) {
        if (content === null) delete artifacts[file]
        else artifacts[file] = content
      }
    }) }
    const loc = { taskId: 1, taskNumber: 7, worktreePath: repo }
    await writeSpecFiles(storage, loc, { 'design.md': 'Design', 'candidates/A.md': 'A' }, 'design')
    expect(artifacts).toEqual({ 'design.md': 'Design', 'candidates/A.md': 'A' })
    await writeSpecFiles(storage, loc, { 'candidates/A.md': null }, 'remove candidate')
    expect(artifacts).toEqual({ 'design.md': 'Design' })
    storage.specArtifactsWrite.mockImplementationOnce(() => { throw new Error('Database full') })
    await expect(writeSpecFiles(storage, loc, { 'design.md': 'New' }, 'change')).rejects.toThrow('Database full')
    expect(await readFile(path.join(repo, '.operon/changes/task-7/design.md'), 'utf8')).toBe('Design')
    await writeSpecFiles(storage, loc, { 'design.md': 'New' }, 'change')
    expect(artifacts['design.md']).toBe('New')
  } finally { await rm(repo, { recursive: true, force: true }) }
})
