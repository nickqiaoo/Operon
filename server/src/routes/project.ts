import { Hono } from 'hono'
import type { AgentBindingStorageAdapter, ChatStorageAdapter, ProjectStorageAdapter, TaskStorageAdapter } from '../storage/interface.js'
import type { CreateProjectInput, CreateWorkspaceInput, Workspace, WorkspaceChat, WorkspaceTask } from '../types/project.js'
import type { Task } from '../types/task.js'
import { specChatRef } from '../services/spec/chats.js'
import { RewindService } from '../services/rewind/index.js'

export function projectRoutes(storage: ProjectStorageAdapter & AgentBindingStorageAdapter & ChatStorageAdapter & TaskStorageAdapter) {
  const router = new Hono()

  // A project's workspaces, each with the board task whose agent runs in it, so
  // the sidebar can show a spec's ticket worktrees under the spec.
  const chatOf = (chatId: number | null | undefined, fallbackWorkspaceId: number | null): WorkspaceChat | null => {
    const ref = chatId != null ? specChatRef(storage, chatId, fallbackWorkspaceId) : null
    return ref ? { chatId: ref.chatId, workspaceId: ref.workspaceId, title: ref.title, providerId: ref.providerId } : null
  }

  // What a spec's folder in the sidebar holds besides its live ticket worktrees:
  // its chat, its coordinator's session, and the tickets that already landed.
  const specExtras = (t: Task): Pick<WorkspaceTask, 'sourceChat' | 'coordinatorChat' | 'finishedTickets'> => {
    const specWs = t.workspaceId ?? null
    const coordinator = t.bindingId != null ? storage.getBinding(t.bindingId) : null
    const finishedTickets: NonNullable<WorkspaceTask['finishedTickets']> = []
    for (const entry of storage.specRunGet(t.id)?.build ?? []) {
      const child = storage.taskGet(entry.taskId)
      if (!child || child.workspaceId != null) continue
      const chat = chatOf(entry.chatIds?.at(-1), specWs)
      if (chat) finishedTickets.push({ id: child.id, number: child.number, title: child.title, status: child.status, chat })
    }
    return {
      sourceChat: chatOf(t.sourceChatId, null),
      coordinatorChat: coordinator?.scopeKind === 'task' && coordinator.scopeKey === String(t.id) ? chatOf(coordinator.activeChatId, specWs) : null,
      finishedTickets,
    }
  }
  const workspacesOf = (projectId: number): (Workspace & { task?: WorkspaceTask })[] => {
    const owners = new Map<number, WorkspaceTask>()
    for (const t of storage.taskList({ projectId, includeArchived: true })) {
      if (t.workspaceId == null) continue
      const binding = t.bindingId != null ? storage.getBinding(t.bindingId) : null
      const chat = chatOf(binding?.activeChatId, t.workspaceId)
      owners.set(t.workspaceId, {
        id: t.id,
        number: t.number,
        title: t.title,
        status: t.status,
        parentTaskId: t.parentTaskId ?? null,
        specStage: t.specStage ?? null,
        archivedAt: t.archivedAt,
        providerId: chat?.providerId ?? t.executionAgent?.provider ?? t.assignedAgent?.provider ?? null,
        ...(t.specStage != null ? specExtras(t) : {}),
      })
    }
    return storage.listWorkspaces(projectId).map((w) => {
      const task = owners.get(w.id)
      return task ? { ...w, task } : w
    })
  }

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
        workspaces: workspacesOf(project.id),
        // Keep specs discoverable after completion reclaims their workspaces.
        specs: storage.taskList({ projectId: project.id, includeArchived: true })
          .filter((task) => task.specStage != null)
          .map((task) => ({
            id: task.id, number: task.number, title: task.title, status: task.status,
            parentTaskId: task.parentTaskId, specStage: task.specStage, archivedAt: task.archivedAt,
          })),
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

  // Pin to / unpin from the top of the list
  router.put('/:id/pin', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const { pinned } = await c.req.json<{ pinned: boolean }>()
    const project = storage.setProjectPinned(id, pinned === true)
    if (!project) return c.json({ error: 'Not found' }, 404)
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
    return c.json({ workspaces: workspacesOf(id) })
  })

  // Create workspace
  router.post('/:id/workspaces', async (c) => {
    const projectId = parseInt(c.req.param('id'), 10)
    const input = await c.req.json<CreateWorkspaceInput>()
    const workspace = storage.createWorkspace(projectId, input)
    return c.json({ workspace })
  })

  // The agent sessions working in a workspace: a task dispatched from the board
  // runs its agent in a worktree of its own, started by the server. The client
  // opens these as tabs when it enters the workspace, since no tab was ever
  // opened for them there.
  router.get('/workspaces/:id/sessions', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const workspace = storage.getWorkspace(id)
    if (!workspace) return c.json({ error: 'Not found' }, 404)
    const sessions = storage
      .listBindings({ scopeKind: 'task', projectId: workspace.projectId })
      .filter((binding) => binding.workspaceId === id && binding.activeChatId != null)
      .map((binding) => {
        const chatId = binding.activeChatId!
        const meta = storage.getChatMeta(chatId)
        return { chatId, title: meta?.title ?? null, providerId: meta?.providerId ?? null }
      })
    return c.json({ sessions })
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
