import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteStorage } from '../storage/sqlite.js'
import { projectRoutes } from './project.js'

let root: string
let storage: SqliteStorage

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'operon-missing-ws-'))
  storage = new SqliteStorage(path.join(root, 'test.sqlite'))
})

afterEach(() => {
  storage.close()
  rmSync(root, { recursive: true, force: true })
})

describe('listing workspaces', () => {
  it('marks a workspace whose directory is gone, and only that one', async () => {
    const project = storage.createProject({ name: 'Repo', rootPath: root })
    storage.createWorkspace(project.id, { name: 'main', branchName: 'main', worktreePath: root })
    storage.createWorkspace(project.id, { name: 'gone', branchName: 'gone', worktreePath: path.join(root, 'deleted-outside-operon') })

    const listed = await (await projectRoutes(storage).request(`/${project.id}/workspaces`)).json() as { workspaces: Array<{ name: string; missing?: boolean }> }
    expect(listed.workspaces.find((w) => w.name === 'main')).not.toHaveProperty('missing')
    expect(listed.workspaces.find((w) => w.name === 'gone')).toMatchObject({ missing: true })

    const tree = await (await projectRoutes(storage).request('/?include=workspaces')).json() as { projects: Array<{ workspaces: Array<{ name: string; missing?: boolean }> }> }
    expect(tree.projects[0].workspaces.find((w) => w.name === 'gone')).toMatchObject({ missing: true })
  })
})
