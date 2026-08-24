import { Hono } from 'hono'
import type { ProjectStorageAdapter } from '../storage/interface.js'
import type { CreateProjectInput, CreateWorkspaceInput } from '../types/project.js'
import { RewindService } from '../services/rewind/index.js'

export function projectRoutes(storage: ProjectStorageAdapter) {
  const router = new Hono()

  // List projects. `?include=workspaces` embeds each project's workspaces so a
  // client only pays one round trip instead of 1 + N — the web build reaches
  // this route through the cloud broker tunnel, where every extra request is a
  // full WAN round trip and the sidebar stays empty until the last one lands.
  // Storage is synchronous sqlite, so fanning out here costs nothing.
  router.get('/', (c) => {
    const projects = storage.listProjects()
    if (c.req.query('include') !== 'workspaces') return c.json({ projects })
    return c.json({
      projects: projects.map((project) => ({
        ...project,
        workspaces: storage.listWorkspaces(project.id),
      })),
    })
  })

  // Get project by id
  router.get('/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const project = storage.getProject(id)
    if (!project) return c.json({ error: 'Not found' }, 404)
    return c.json({ project })
  })

  // Create project
  router.post('/', async (c) => {
    const input = await c.req.json<CreateProjectInput>()
    const project = storage.createProject(input)
    return c.json({ project })
  })

  // Delete project
  router.delete('/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    // Capture workspace cwds before the cascading DB delete so we can reclaim
    // their rewind snapshot repos.
    const worktreePaths = storage.listWorkspaces(id).map((w) => w.worktreePath)
    storage.deleteProject(id)
    for (const cwd of worktreePaths) {
      void RewindService.removeRepo(cwd)
    }
    return c.json({ success: true })
  })

  // List workspaces for a project
  router.get('/:id/workspaces', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const workspaces = storage.listWorkspaces(id)
    return c.json({ workspaces })
  })

  // Create workspace
  router.post('/:id/workspaces', async (c) => {
    const projectId = parseInt(c.req.param('id'), 10)
    const input = await c.req.json<CreateWorkspaceInput>()
    const workspace = storage.createWorkspace(projectId, input)
    return c.json({ workspace })
  })

  // Delete workspace
  router.delete('/workspaces/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const workspace = storage.getWorkspace(id)
    storage.deleteWorkspace(id)
    // Reclaim the workspace's rewind snapshot repo (cwd is gone now).
    if (workspace) {
      void RewindService.removeRepo(workspace.worktreePath)
    }
    return c.json({ success: true })
  })

  return router
}
