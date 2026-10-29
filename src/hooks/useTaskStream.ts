import { useEffect } from 'react'
import { api } from '@/lib/api'
import { subscribeSse } from '@/lib/sse'
import { useTaskStore } from '@/stores/task-store'
import { useProjectStore, type Project } from '@/stores/project-store'
import type { TaskListItem } from '@/types/task'

type TaskStreamEvent = { type: 'task_upsert'; task: TaskListItem }

/** Ignore execution-only updates; the tree only needs navigation metadata. */
export function taskChangesProjectTree(task: TaskListItem, projects: readonly Project[]): boolean {
  const project = projects.find((entry) => entry.id === task.projectId)
  const workspace = project?.workspaces.find((entry) => entry.task?.id === task.id)
  const previous = workspace?.task ?? project?.specs?.find((entry) => entry.id === task.id)
  if (task.specStage == null && task.workspaceId == null && !previous) return false
  if (!previous) return true
  return previous.title !== task.title || previous.status !== task.status ||
    previous.specStage !== task.specStage || previous.parentTaskId !== task.parentTaskId ||
    (previous.archivedAt ?? null) !== (task.archivedAt ?? null) ||
    (workspace?.id ?? null) !== task.workspaceId
}

/**
 * Mount once per shell, including while chatting: task changes update the board,
 * open detail and project navigation without requiring a visit to the board.
 */
export function useTaskStream(projectId: number | null) {
  const applyUpsert = useTaskStore((s) => s.applyUpsert)

  useEffect(() => {
    let closed = false
    let refreshing = false
    const pending = new Map<number, TaskListItem>()
    let timer: ReturnType<typeof setTimeout> | null = null
    // A reconnect sends the whole task snapshot. Coalesce it into one tree read,
    // and keep a trailing refresh if another change arrives during that read.
    const scheduleRefresh = () => {
      if (closed || refreshing || timer != null) return
      timer = setTimeout(async () => {
        timer = null
        const tasks = [...pending.values()]
        pending.clear()
        if (!tasks.some((task) => taskChangesProjectTree(task, useProjectStore.getState().projects))) return
        refreshing = true
        try {
          await useProjectStore.getState().loadProjects()
        } catch (error) {
          console.error('Failed to refresh project navigation:', error)
        } finally {
          refreshing = false
          if (pending.size > 0 && !closed) scheduleRefresh()
        }
      }, 100)
    }
    const subscription = subscribeSse<TaskStreamEvent>({
      url: () => api.taskStreamUrl(projectId),
      onEvent: (event) => {
        if (event.type !== 'task_upsert') return
        if (pending.has(event.task.id) || taskChangesProjectTree(event.task, useProjectStore.getState().projects)) {
          pending.set(event.task.id, event.task)
          scheduleRefresh()
        }
        applyUpsert(event.task)
      },
    })
    return () => {
      closed = true
      if (timer != null) clearTimeout(timer)
      subscription.close()
    }
  }, [projectId, applyUpsert])
}
