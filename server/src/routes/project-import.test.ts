import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteStorage } from '../storage/sqlite.js'
import { projectRoutes } from './project.js'

let storage: SqliteStorage

const project = { name: 'Example', rootPath: '/projects/example' }
const workspace = { name: 'main', branchName: 'main', worktreePath: project.rootPath }

beforeEach(() => { storage = new SqliteStorage(':memory:') })
afterEach(() => { storage.close() })

describe('project checkout import', () => {
  it('registers a checkout only once for concurrent imports', async () => {
    const app = projectRoutes(storage)
    const responses = await Promise.all([1, 2].map(() => app.request('/import', {
      method: 'POST', body: JSON.stringify({ project, workspace }),
    })))

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const [first, second] = await Promise.all(responses.map((response) => response.json()))
    expect(first).toEqual(second)
    const projects = storage.listProjects()
    expect(projects).toHaveLength(1)
    expect(storage.listWorkspaces(projects[0].id)).toMatchObject([workspace])
  })

  it('adds a linked checkout to a previously registered project', async () => {
    const existing = storage.createProject({ ...project, rootPath: `${project.rootPath}/` })
    const linked = { name: 'feature', branchName: 'feature', worktreePath: '/projects/feature' }
    const response = await projectRoutes(storage).request('/import', {
      method: 'POST', body: JSON.stringify({ project, workspace: linked }),
    })

    expect(response.status).toBe(200)
    expect(storage.listProjects()).toEqual([existing])
    expect(storage.listWorkspaces(existing.id)).toMatchObject([linked])
  })
})
