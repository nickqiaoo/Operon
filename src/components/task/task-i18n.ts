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

/**
 * Localized rendering for system activity rows. The server writes a stable
 * `meta.event` code (plus the parameters the sentence needs) next to the
 * English `body`; rows without a known code fall back to the raw body.
 */
export const ACTIVITY_EVENT_MESSAGES = defineMessages({
  "task.created": { id: "task.activity.event.created", defaultMessage: "created this task" },
  "task.archived": { id: "task.activity.event.archived", defaultMessage: "archived this task" },
  "task.unarchived": { id: "task.activity.event.unarchived", defaultMessage: "unarchived this task" },
  "comment.forwarded": { id: "task.activity.event.commentForwarded", defaultMessage: "sent {author}'s comment to the agent" },
  "linear.published": { id: "task.activity.event.linearPublished", defaultMessage: "published to Linear as {identifier}" },
  "linear.mentioned": { id: "task.activity.event.linearMentioned", defaultMessage: "{creator} mentioned the agent on {where}" },
  "linear.delegated": { id: "task.activity.event.linearDelegated", defaultMessage: "{creator} delegated {where} to the agent" },
  "linear.sessionOpened": { id: "task.activity.event.linearSessionOpened", defaultMessage: "Linear opened an agent session on {where}" },
  "pr.opened": { id: "task.activity.event.prOpened", defaultMessage: "opened PR #{number}" },
  "pr.pushed": { id: "task.activity.event.prPushed", defaultMessage: "pushed {branch} to PR #{number}" },
  "pr.closed": { id: "task.activity.event.prClosed", defaultMessage: "PR #{number} closed without merge" },
  "pr.reopened": { id: "task.activity.event.prReopened", defaultMessage: "PR #{number} reopened" },
  "pr.finalizeFailed": { id: "task.activity.event.prFinalizeFailed", defaultMessage: "PR #{number} merged, but the task could not be finalized: {reason}" },
  "pr.acknowledged": { id: "task.activity.event.prAcknowledged", defaultMessage: "acknowledged {author} on PR #{number}" },
  "signoff.unverified": { id: "task.activity.event.signoffUnverified", defaultMessage: "signed off without verification — no verifier ran" },
  "review.ready": { id: "task.activity.event.reviewReady", defaultMessage: "ready for human review — mark Done to merge this subtask into its parent" },
  "verify.started": { id: "task.activity.event.verifyStarted", defaultMessage: "verification started by {agent} on {branch}" },
  "branch.merged": { id: "task.activity.event.branchMerged", defaultMessage: "merged {branch} into {target}" },
  "subtask.merged": { id: "task.activity.event.subtaskMerged", defaultMessage: "merged subtask #{number} into {branch}" },
  "parent.merged": { id: "task.activity.event.parentMerged", defaultMessage: "merged into parent {branch}" },
  "artifact.approved": { id: "task.activity.event.artifactApproved", defaultMessage: "approved the {kind}" },
})

export function activityEventMessage(event: unknown): MessageDescriptor | null {
  return typeof event === "string" && event in ACTIVITY_EVENT_MESSAGES
    ? ACTIVITY_EVENT_MESSAGES[event as keyof typeof ACTIVITY_EVENT_MESSAGES]
    : null
}

/** Placeholder actor names the server writes when no real person / agent is attached. */
export const ACTOR_MESSAGES = defineMessages({
  system: { id: "task.actor.system", defaultMessage: "System" },
  human: { id: "task.actor.human", defaultMessage: "Someone" },
  You: { id: "task.actor.you", defaultMessage: "You" },
})
