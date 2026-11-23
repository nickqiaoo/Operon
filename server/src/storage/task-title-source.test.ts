import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { SqliteStorage } from './sqlite.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-task-title-'))
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

describe.skipIf(!opened)('task title source', () => {
  it('records a typed title as the user\'s', () => {
    const task = storage.taskCreate({ projectId: 1, title: 'Typed' })
    expect(task.titleSource).toBe('user')
    expect(storage.taskReplaceAutoTitle(task.id, 'Typed', 'Generated')).toBe(false)
    expect(storage.taskGet(task.id)?.title).toBe('Typed')
  })

  it('swaps a generated title in for the placeholder', () => {
    const task = storage.taskCreate({ projectId: 1, title: 'placeholder', titleSource: 'auto', description: 'placeholder' })
    expect(task.titleSource).toBe('auto')
    expect(storage.taskReplaceAutoTitle(task.id, 'placeholder', 'Generated')).toBe(true)
    expect(storage.taskGet(task.id)).toMatchObject({ title: 'Generated', titleSource: 'auto' })
  })

  it('keeps a title edited before the generated one arrived', () => {
    const task = storage.taskCreate({ projectId: 1, title: 'placeholder', titleSource: 'auto' })
    storage.taskUpdate(task.id, { title: 'Edited' }, { type: 'human', name: 'You' })
    expect(storage.taskGet(task.id)?.titleSource).toBe('user')
    expect(storage.taskReplaceAutoTitle(task.id, 'placeholder', 'Generated')).toBe(false)
    expect(storage.taskGet(task.id)?.title).toBe('Edited')
  })

  it('keeps it even when edited back to the placeholder text', () => {
    const task = storage.taskCreate({ projectId: 1, title: 'placeholder', titleSource: 'auto' })
    storage.taskUpdate(task.id, { title: 'placeholder' })
    expect(storage.taskReplaceAutoTitle(task.id, 'placeholder', 'Generated')).toBe(false)
  })
})
