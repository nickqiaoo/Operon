import { defineMessages, type MessageDescriptor } from "react-intl"
import type { TaskStatus, TaskPriority } from "@/types/task"

/**
 * Status / priority labels as react-intl message descriptors. These enum
 * labels are consumed both as plain strings (filter options, group headers)
 * and as JSX, so they live as descriptors and are translated at the call site
 * via `intl.formatMessage(...)`. `defineMessages` keeps them statically
 * extractable by @formatjs/cli (English here is the source of truth).
 */
export const STATUS_MESSAGES = defineMessages({
  todo: { id: "task.status.todo", defaultMessage: "Todo" },
  in_progress: { id: "task.status.in_progress", defaultMessage: "In Progress" },
  in_review: { id: "task.status.in_review", defaultMessage: "In Review" },
  done: { id: "task.status.done", defaultMessage: "Done" },
  cancelled: { id: "task.status.cancelled", defaultMessage: "Cancelled" },
}) satisfies Record<TaskStatus, MessageDescriptor>

const PRIORITY_MESSAGES = defineMessages({
  p0: { id: "task.priority.0", defaultMessage: "No priority" },
  p1: { id: "task.priority.1", defaultMessage: "Low" },
  p2: { id: "task.priority.2", defaultMessage: "Medium" },
  p3: { id: "task.priority.3", defaultMessage: "High" },
  p4: { id: "task.priority.4", defaultMessage: "Urgent" },
})

export function priorityMessage(p: TaskPriority): MessageDescriptor {
  return PRIORITY_MESSAGES[`p${p}` as keyof typeof PRIORITY_MESSAGES]
}
