import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { useEditorStore } from "@/stores/editor-store"
import type { Task } from "@/types/task"

/**
 * The task that a Dispatch-created workspace came from, or null for a workspace
 * the user made by hand. Lets the editor offer a way back to the task page.
 *
 * Only identity is read from the result (`#number`, title) — never live status —
 * so a single fetch per workspace is enough and there is nothing to keep in sync.
 */
export function useWorkspaceTask(): { task: Task | null; projectId: number | null } {
  const workspaceId = useEditorStore((s) => s.currentWorkspaceId)
  const projectId = useEditorStore((s) => s.currentProjectId)
  const [task, setTask] = useState<Task | null>(null)

  useEffect(() => {
    if (workspaceId == null) {
      setTask(null)
      return
    }
    // Switching workspaces mid-flight would otherwise let the older response
    // land last and label the new workspace with the previous task.
    let cancelled = false
    setTask(null)
    void api
      .taskGetByWorkspace(workspaceId)
      .then((res) => {
        if (!cancelled) setTask(res.task ?? null)
      })
      .catch(() => {
        if (!cancelled) setTask(null)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  return { task, projectId }
}
