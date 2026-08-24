import { create } from 'zustand'
import { api } from '@/lib/api'
import { trackEvent } from '@/lib/analytics'
import type {
  CreateTaskInput,
  CreateTaskLabelInput,
  CreateTeamInput,
  UpdateTeamInput,
  PreparedSubtask,
  TaskDetail,
  TaskLabel,
  TaskListItem,
  Team,
  UpdateTaskInput,
} from '@/types/task'

interface TaskStore {
  projectId: number | null
  tasks: TaskListItem[]
  labels: TaskLabel[]
  teams: Team[]
  detail: TaskDetail | null
  loading: boolean

  load: (projectId: number) => Promise<void>
  reload: () => Promise<void>
  openDetail: (taskId: number) => Promise<void>
  closeDetail: () => void
  create: (input: Omit<CreateTaskInput, 'projectId'>) => Promise<TaskDetail>
  update: (taskId: number, updates: UpdateTaskInput) => Promise<void>
  setArchived: (taskId: number, archived: boolean) => Promise<void>
  dispatch: (
    taskId: number,
    assignedAgentId: number,
    subtaskAgents?: Record<number, number>,
  ) => Promise<void>
  /** SDD parent: auto approve+decompose, returning its subtasks (empty = tiny change). */
  prepare: (taskId: number) => Promise<PreparedSubtask[]>
  comment: (taskId: number, body: string) => Promise<void>
  /** Apply a live task_upsert from the SSE stream (agent or other-window change). */
  applyUpsert: (task: TaskListItem) => void
  createLabel: (input: Omit<CreateTaskLabelInput, 'projectId'>) => Promise<TaskLabel>
  createTeam: (input: Omit<CreateTeamInput, 'projectId'>) => Promise<Team>
  updateTeam: (teamId: number, input: UpdateTeamInput) => Promise<Team>
  deleteTeam: (teamId: number) => Promise<void>
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

function sortTeams(teams: Team[]): Team[] {
  return [...teams].sort((a, b) => a.name.localeCompare(b.name))
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  projectId: null,
  tasks: [],
  labels: [],
  teams: [],
  detail: null,
  loading: false,

  load: async (projectId) => {
    set({ projectId, loading: true, detail: null })
    try {
      const [{ tasks }, { labels }, { teams }] = await Promise.all([
        // Fetch archived too — the board filters them client-side via the
        // "Show archived" toggle, so toggling needs no refetch.
        api.taskList(projectId, { includeArchived: true }),
        api.taskLabelList(projectId),
        api.taskTeamList(projectId),
      ])
      set({ tasks, labels, teams, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  reload: async () => {
    const pid = get().projectId
    if (pid == null) return
    const { tasks } = await api.taskList(pid, { includeArchived: true })
    set({ tasks })
  },

  openDetail: async (taskId) => {
    const { task } = await api.taskGet(taskId)
    set({ detail: task })
  },

  closeDetail: () => set({ detail: null }),

  create: async (input) => {
    const pid = get().projectId
    if (pid == null) throw new Error('No active project')
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
    // Optimistic — archived tasks drop out of the default view immediately.
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, archivedAt } : t)),
      detail: s.detail && s.detail.id === taskId ? { ...s.detail, archivedAt } : s.detail,
    }))
    try {
      const { task } = await api.taskSetArchived(taskId, archived)
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === taskId ? toListItem(task) : t)),
        detail: s.detail && s.detail.id === taskId ? task : s.detail,
      }))
    } catch (e) {
      set({ tasks: prev, detail: prevDetail })
      throw e
    }
  },

  dispatch: async (taskId, assignedAgentId, subtaskAgents) => {
    const { task } = await api.taskDispatch(taskId, assignedAgentId, subtaskAgents)
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? toListItem(task) : t)),
      detail: s.detail && s.detail.id === taskId ? task : s.detail,
    }))
  },

  prepare: async (taskId) => {
    const { subtasks } = await api.taskPrepare(taskId)
    return subtasks ?? []
  },

  applyUpsert: (task) => {
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
    const pid = get().projectId
    if (pid == null) throw new Error('No active project')
    const { label } = await api.taskLabelCreate({ ...input, projectId: pid })
    set((s) => ({ labels: [...s.labels, label] }))
    return label
  },

  createTeam: async (input) => {
    const pid = get().projectId
    if (pid == null) throw new Error('No active project')
    const { team } = await api.taskTeamCreate({ ...input, projectId: pid })
    set((s) => ({ teams: sortTeams([...s.teams, team]) }))
    return team
  },

  updateTeam: async (teamId, input) => {
    const prevTeams = get().teams
    const prevDetail = get().detail
    const existing = prevTeams.find((team) => team.id === teamId)
    if (!existing) throw new Error('Team not found')
    const optimistic = { ...existing, ...input }
    set((s) => ({
      teams: sortTeams(s.teams.map((team) => (team.id === teamId ? optimistic : team))),
      detail:
        s.detail?.team?.id === teamId
          ? { ...s.detail, team: optimistic }
          : s.detail,
    }))
    try {
      const { team } = await api.taskTeamUpdate(teamId, input)
      set((s) => ({
        teams: sortTeams(s.teams.map((item) => (item.id === teamId ? team : item))),
        detail: s.detail?.team?.id === teamId ? { ...s.detail, team } : s.detail,
      }))
      return team
    } catch (e) {
      set({ teams: prevTeams, detail: prevDetail })
      throw e
    }
  },

  deleteTeam: async (teamId) => {
    const prevTeams = get().teams
    const prevTasks = get().tasks
    const prevDetail = get().detail
    set((s) => ({
      teams: s.teams.filter((team) => team.id !== teamId),
      tasks: s.tasks.map((task) => (task.teamId === teamId ? { ...task, teamId: null } : task)),
      detail:
        s.detail?.teamId === teamId
          ? { ...s.detail, teamId: null, team: null }
          : s.detail,
    }))
    try {
      await api.taskTeamDelete(teamId)
    } catch (e) {
      set({ teams: prevTeams, tasks: prevTasks, detail: prevDetail })
      throw e
    }
  },

  createSubtask: async (parentId, title) => {
    const pid = get().projectId
    if (pid == null) return
    await api.taskCreate({ projectId: pid, title, parentTaskId: parentId })
    // Refresh the parent detail (children + possibly a freshly-formed team) and
    // the team list (the epic path may have created one).
    await get().openDetail(parentId)
    const { teams } = await api.taskTeamList(pid)
    set({ teams })
  },
}))
