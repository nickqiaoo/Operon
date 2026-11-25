import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import type { AgentBindingStorageAdapter, ChatStorageAdapter, ProjectStorageAdapter, TaskStorageAdapter } from '../storage/interface.js'
import type { CreateProjectInput, CreateWorkspaceInput, TaskChildSession, Workspace, WorkspaceChat, WorkspaceTask } from '../types/project.js'
import type { Task } from '../types/task.js'
import { specChatRef } from '../services/spec/chats.js'
import { RewindService } from '../services/rewind/index.js'
import { provisionAutoWorkspace } from '../services/workspace-provision.js'
import { streamSSE } from 'hono/streaming'
import { onProjectTreeEvent } from '../services/channel-bus.js'

export function projectRoutes(storage: ProjectStorageAdapter & AgentBindingStorageAdapter & ChatStorageAdapter & TaskStorageAdapter) {
  const router = new Hono()

  // ---- Project tree changes (SSE), served on /api/events as `projects` ----
  // Registered first so 'stream' is never parsed as a project id. Opens with
  // `ready`: a client reconnecting may have missed changes and reloads on it.
  router.get('/stream', (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false
      stream.onAbort(() => {
        closed = true
      })
      await stream.writeSSE({ data: JSON.stringify({ type: 'ready' }) }).catch(() => {})
      const unsub = onProjectTreeEvent((event) => {
        if (closed) return
        stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {})
      })
      while (!closed) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      }
      unsub()
    })
  })

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
  // Sub-tasks whose session nests under their parent task's session in the tree.
  const taskChildrenOf = (tasks: Task[]): TaskChildSession[] => {
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const chatIdOf = (t: Task) => (t.bindingId != null ? storage.getBinding(t.bindingId)?.activeChatId ?? null : null)
    const out: TaskChildSession[] = []
    for (const t of tasks) {
      const parent = t.parentTaskId != null ? byId.get(t.parentTaskId) : undefined
      if (!parent || parent.specStage != null || t.archivedAt != null) continue
      const chatId = chatIdOf(t)
      const parentChatId = chatIdOf(parent)
      if (chatId == null || parentChatId == null) continue
      const meta = storage.getChatMeta(chatId)
      out.push({
        taskId: t.id,
        number: t.number,
        title: t.title,
        status: t.status,
        parentChatId,
        chatId,
        workspaceId: t.workspaceId,
        providerId: meta?.providerId ?? t.assignedAgent?.provider ?? null,
        modelId: t.assignedAgent?.model ?? null,
        updatedAt: t.updatedAt,
      })
    }
    return out
  }

  const workspacesOf = (projectId: number): (Workspace & { task?: WorkspaceTask })[] => {
    const owners = new Map<number, WorkspaceTask>()
    for (const t of storage.taskList({ projectId, includeArchived: true })) {
      // A shared-mode task works in a workspace it does not own.
      if (t.workspaceId == null || t.workspaceMode === 'shared') continue
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
      return { ...w, ...(task ? { task } : {}), ...(existsSync(w.worktreePath) ? {} : { missing: true as const }) }
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
      projects: projects.map((project) => {
        const tasks = storage.taskList({ projectId: project.id, includeArchived: true })
        return {
        ...project,
        workspaces: workspacesOf(project.id),
        taskChildren: taskChildrenOf(tasks),
        // Keep specs discoverable after completion reclaims their workspaces.
        specs: tasks
          .filter((task) => task.specStage != null)
          .map((task) => ({
            id: task.id, number: task.number, title: task.title, status: task.status,
            parentTaskId: task.parentTaskId, specStage: task.specStage, archivedAt: task.archivedAt,
          })),
        }
      }),
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

  // A new chat's worktree: a fresh branch cut from `base`, under a placeholder
  // name until the chat's messages say what it is for.
  router.post('/:id/workspaces/auto', async (c) => {
    const projectId = parseInt(c.req.param('id'), 10)
    if (!storage.getProject(projectId)) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.json<{ base?: string }>().catch(() => ({}) as { base?: string })
    try {
      // Named later, from the chat's messages (workspace-naming).
      const workspace = await provisionAutoWorkspace(storage, {
        projectId,
        base: body.base?.trim() || undefined,
      })
      return c.json({ workspace })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'Failed to create workspace' }, 500)
    }
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
      // Only tasks still under way. A finished task keeps its binding (and, in
      // 'shared' mode, its workspace is often main), so without this every
      // launch reopened tabs for long-done tasks the user had closed.
      .filter((binding) => storage.taskGet(Number(binding.scopeKey))?.status === 'in_progress')
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
