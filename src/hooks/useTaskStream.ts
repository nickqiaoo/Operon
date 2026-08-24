import { useEffect } from 'react'
import { api } from '@/lib/api'
import { subscribeSse } from '@/lib/sse'
import { useTaskStore } from '@/stores/task-store'
import type { TaskListItem } from '@/types/task'

type TaskStreamEvent = { type: 'task_upsert'; task: TaskListItem }

/**
 * Subscribe to the project's task SSE stream so the board + open detail update
 * live when an agent (or another window) changes a task.
 */
export function useTaskStream(projectId: number) {
  const applyUpsert = useTaskStore((s) => s.applyUpsert)

  useEffect(() => {
    const subscription = subscribeSse<TaskStreamEvent>({
      url: () => api.taskStreamUrl(projectId),
      onEvent: (event) => {
        if (event.type === 'task_upsert') applyUpsert(event.task)
      },
    })
    return () => subscription.close()
  }, [projectId, applyUpsert])
}
