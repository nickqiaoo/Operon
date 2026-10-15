import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { SqliteStorage } from './sqlite.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-project-pin-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

// better-sqlite3 is built for Electron's Node; under a plain Node it does not load. Run with
// `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <this file>` to cover it.
let opened: SqliteStorage | undefined
try {
  opened = new SqliteStorage(path.join(dir, 'test.db'))
} catch {
  opened = undefined
}
const storage = opened as SqliteStorage

describe.skipIf(!opened)('project pinning', () => {
  it('lists pinned projects first, in the order they were pinned', async () => {
    const a = storage.createProject({ name: 'a', rootPath: '/a' })
    await new Promise((r) => setTimeout(r, 2))
    const b = storage.createProject({ name: 'b', rootPath: '/b' })
    await new Promise((r) => setTimeout(r, 2))
    const c = storage.createProject({ name: 'c', rootPath: '/c' })
    expect(storage.listProjects().map((p) => p.name)).toEqual(['c', 'b', 'a'])

    expect(storage.setProjectPinned(a.id, true)?.pinnedAt).toEqual(expect.any(Number))
    await new Promise((r) => setTimeout(r, 2))
    storage.setProjectPinned(b.id, true)
    expect(storage.listProjects().map((p) => p.name)).toEqual(['a', 'b', 'c'])

    // Pinning again keeps its place among the pinned.
    const first = storage.getProject(a.id)?.pinnedAt
    storage.setProjectPinned(a.id, true)
    expect(storage.getProject(a.id)?.pinnedAt).toBe(first)

    storage.setProjectPinned(a.id, false)
    expect(storage.getProject(a.id)?.pinnedAt).toBeNull()
    expect(storage.listProjects().map((p) => p.name)).toEqual(['b', 'c', 'a'])
    expect(storage.setProjectPinned(c.id + 100, true)).toBeNull()
  })
})
