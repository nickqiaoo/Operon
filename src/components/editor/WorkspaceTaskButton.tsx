import { ClipboardList } from "lucide-react"
import { useIntl } from "react-intl"
import { Button } from "@/components/ui/button"
import { useEditorStore } from "@/stores/editor-store"
import { useWorkspaceTask } from "./hooks/useWorkspaceTask"

/**
 * Shortcut back to the task a workspace was dispatched from. Renders nothing for
 * hand-made workspaces, which have no task to point at — the tab bar stays as
 * quiet as it is today unless the link actually exists.
 *
 * Navigation reuses the same `requestOpenTask` channel as the task cards in a
 * transcript, so desktop and mobile both land on the task detail page.
 */
export function WorkspaceTaskButton() {
  const intl = useIntl()
  const requestOpenTask = useEditorStore((s) => s.requestOpenTask)
  const { task, projectId } = useWorkspaceTask()

  if (!task || projectId == null) return null

  const label = intl.formatMessage(
    { id: "editor.tabs.openTask", defaultMessage: "Open task #{number} — {title}" },
    { number: task.number, title: task.title },
  )

  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="workspace-task-button"
      title={label}
      aria-label={label}
      className="h-7 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      onClick={() => requestOpenTask({ projectId, taskId: task.id })}
    >
      <ClipboardList className="h-3.5 w-3.5" />
      {`#${task.number}`}
    </Button>
  )
}
