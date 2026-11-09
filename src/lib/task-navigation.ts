import { useEffect } from "react"

/** Jump to a task's detail page. Raised by surfaces shared by both shells. */
export interface TaskNavigationRequest {
  projectId: number
  /** Database id (not the per-project `#number`), which is what TasksPage opens by. */
  taskId: number
  /** Open it as a spec in `projectId`, from a surface with no current project (the assistant's thread). */
  spec?: boolean
}

type TaskNavigationHandler = (request: TaskNavigationRequest) => void

let handler: TaskNavigationHandler | null = null

/** Open a task wherever the mounted shell keeps tasks (Board on desktop, Channel on the phone). */
export function requestOpenTask(request: TaskNavigationRequest): void {
  handler?.(request)
}

/** Called once by each shell to say where a task opens. Pass a stable function. */
export function useTaskNavigationHandler(next: TaskNavigationHandler): void {
  useEffect(() => {
    handler = next
    return () => {
      if (handler === next) handler = null
    }
  }, [next])
}
