import { taskSubtreeIds } from '@shared/task-tree'
import { create } from 'zustand'
import { api } from '@/lib/api'
import { useProjectStore } from '@/stores/project-store'
import { trackEvent } from '@/lib/analytics'
import type {
  CreateTaskInput,
  CreateTaskLabelInput,
  TaskDetail,
  TaskLabel,
  TaskListItem,
  UpdateTaskInput,
} from '@/types/task'

interface TaskStore {
  /** The board's scope: one project, or null for every project's tasks. */
  projectId: number | null
  tasks: TaskListItem[]
  labels: TaskLabel[]
  detail: TaskDetail | null
  loading: boolean

  load: (projectId: number | null) => Promise<void>
  reload: () => Promise<void>
  openDetail: (taskId: number) => Promise<void>
  closeDetail: () => void
  /** projectId defaults to the board's scope; a board over every project must name one. */
  create: (input: Omit<CreateTaskInput, 'projectId'> & { projectId?: number }) => Promise<TaskDetail>
  update: (taskId: number, updates: UpdateTaskInput) => Promise<void>
  setArchived: (taskId: number, archived: boolean) => Promise<void>
  dispatch: (taskId: number, assignedAgentId: number) => Promise<void>
  /** Wake a dispatched task's agent in its existing session to carry on. */
  resume: (taskId: number) => Promise<void>
  comment: (taskId: number, body: string) => Promise<void>
  /** Apply a live task_upsert from the SSE stream (agent or other-window change). */
  applyUpsert: (task: TaskListItem) => void
  createLabel: (input: CreateTaskLabelInput) => Promise<TaskLabel>
  /** Create a sub-task under a parent (epic path) and refresh the parent's detail. */
  createSubtask: (parentId: number, title: string) => Promise<void>
}

function toListItem(t: TaskDetail): TaskListItem {
  const { activity: _activity, ...rest } = t
  return rest
}

/** Drop labelIds (not a field on the row) for optimistic patching. */
function patchFields(u: UpdateTaskInput): Partial<TaskListItem> {
  const { labelIds: _labelIds, ...rest } = u
  return rest as Partial<TaskListItem>
}

function upsertTask(tasks: TaskListItem[], task: TaskListItem): TaskListItem[] {
  const exists = tasks.some((t) => t.id === task.id)
  if (!exists) return [task, ...tasks]
  return tasks.map((t) => (t.id === task.id ? task : t))
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  projectId: null,
  tasks: [],
  labels: [],
  detail: null,
  loading: false,

  load: async (projectId) => {
    // Re-entering the same scope keeps what's on screen (and a deep-linked detail
    // that opened first) and refreshes underneath; a new scope starts clean.
    const same = get().projectId === projectId && get().tasks.length > 0
    set((s) => ({ projectId, loading: !same, detail: same ? s.detail : null }))
    try {
      const [{ tasks }, { labels }] = await Promise.all([
        // Fetch archived too — the board filters them client-side via the
        // "Show archived" toggle, so toggling needs no refetch.
        api.taskList(projectId, { includeArchived: true }),
        api.taskLabelList(projectId),
      ])
      set({ tasks, labels, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  reload: async () => {
    const { tasks } = await api.taskList(get().projectId, { includeArchived: true })
    set({ tasks })
  },

  openDetail: async (taskId) => {
    const { task } = await api.taskGet(taskId)
    set({ detail: task })
  },

  closeDetail: () => set({ detail: null }),

  create: async (input) => {
    const pid = input.projectId ?? get().projectId
    if (pid == null) throw new Error('Pick a project for the task')
    const { task } = await api.taskCreate({ ...input, projectId: pid })
    set((s) => ({ tasks: upsertTask(s.tasks, toListItem(task)) }))
    return task
  },

  update: async (taskId, updates) => {
    const prev = get().tasks
    const prevDetail = get().detail
    const prevStatus = prev.find((t) => t.id === taskId)?.status
    // Optimistic
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, ...patchFields(updates) } : t)),
      detail:
        s.detail && s.detail.id === taskId ? { ...s.detail, ...patchFields(updates) } : s.detail,
    }))
    try {
      const { task } = await api.taskUpdate(taskId, updates)
      // Reaching a terminal state is the outcome of the work, as opposed to the
      // creation events that only record it being started.
      if (updates.status && updates.status !== prevStatus
        && (updates.status === 'done' || updates.status === 'cancelled')) {
        trackEvent('task_status_settled', { status: updates.status, from: prevStatus })
      }
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === taskId ? toListItem(task) : t)),
        detail: s.detail && s.detail.id === taskId ? task : s.detail,
      }))
    } catch (e) {
      set({ tasks: prev, detail: prevDetail })
      throw e
    }
  },

  setArchived: async (taskId, archived) => {
    const prev = get().tasks
    const prevDetail = get().detail
    const archivedAt = archived ? Date.now() : null
    const affectedIds = archived ? taskSubtreeIds(prev, taskId) : new Set([taskId])
    // Optimistic — the whole subtree leaves the default view immediately.
    set((s) => ({
      tasks: s.tasks.map((t) => affectedIds.has(t.id) && (!archived || t.archivedAt == null) ? { ...t, archivedAt } : t),
      detail: s.detail && affectedIds.has(s.detail.id) && (!archived || s.detail.archivedAt == null)
        ? { ...s.detail, archivedAt } : s.detail,
    }))
    try {
      const result = await api.taskSetArchived(taskId, archived)
      let task = result.task
      let tasks = result.tasks
      // A hot-reloaded frontend may still talk to a server without cascading
      // archive responses. Read its full tree and finish the cascade there too.
      if (!tasks) {
        const snapshot = await api.taskList(task.projectId, { includeArchived: true })
        const subtree = archived ? taskSubtreeIds(snapshot.tasks, taskId) : new Set([taskId])
        const descendants = snapshot.tasks.filter((row) => subtree.has(row.id) && row.id !== taskId && row.archivedAt == null)
        if (archived && descendants.length > 0) {
          await Promise.all(descendants.map((row) => api.taskSetArchived(row.id, true)))
          const [freshList, freshDetail] = await Promise.all([
            api.taskList(task.projectId, { includeArchived: true }),
            api.taskGet(taskId),
          ])
          tasks = freshList.tasks.filter((row) => subtree.has(row.id))
          task = freshDetail.task
        } else {
          tasks = snapshot.tasks.filter((row) => subtree.has(row.id))
        }
      }
      const updated = new Map(tasks.map((row) => [row.id, row]))
      for (const row of tasks) useProjectStore.getState().setWorkspaceTaskArchived(row.id, row.archivedAt)
      set((s) => ({
        tasks: s.tasks.map((t) => updated.get(t.id) ?? t),
        detail: s.detail?.id === taskId ? task : s.detail && updated.has(s.detail.id)
          ? { ...s.detail, ...updated.get(s.detail.id) } : s.detail,
      }))
    } catch (e) {
      set({ tasks: prev, detail: prevDetail })
      throw e
    }
  },

  dispatch: async (taskId, assignedAgentId) => {
    const { task } = await api.taskDispatch(taskId, assignedAgentId)
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? toListItem(task) : t)),
      detail: s.detail && s.detail.id === taskId ? task : s.detail,
    }))
  },

  resume: async (taskId) => {
    const { task } = await api.taskResume(taskId)
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? toListItem(task) : t)),
      detail: s.detail && s.detail.id === taskId ? task : s.detail,
    }))
  },

  applyUpsert: (task) => {
    useProjectStore.getState().setWorkspaceTaskArchived(task.id, task.archivedAt)
    const scope = get().projectId
    if (scope != null && task.projectId !== scope) return
    set((s) => ({ tasks: upsertTask(s.tasks, task) }))
    // If this task's detail is open, refetch it to pull fresh activity-feed rows
    // (status/dispatch/comment events the agent just produced).
    const { detail } = get()
    if (detail && detail.id === task.id) void get().openDetail(task.id)
  },

  comment: async (taskId, body) => {
    const { activity } = await api.taskComment(taskId, body)
    set((s) => ({
      detail:
        s.detail && s.detail.id === taskId
          ? { ...s.detail, activity: [...s.detail.activity, activity] }
          : s.detail,
    }))
  },

  createLabel: async (input) => {
    const { label } = await api.taskLabelCreate(input)
    set((s) => ({ labels: [...s.labels, label] }))
    return label
  },

  createSubtask: async (parentId, title) => {
    // A sub-task lives in its parent's project, whatever the board's scope.
    const open = get().detail
    const pid = open?.id === parentId ? open.projectId : (await api.taskGet(parentId)).task.projectId
    await api.taskCreate({ projectId: pid, title, parentTaskId: parentId })
    // Refresh the parent detail so the new child shows up.
    await get().openDetail(parentId)
  },
}))
