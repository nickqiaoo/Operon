import { defineMessages, type IntlShape } from "react-intl"

import type { Notification } from "@/types/notification"

/**
 * Inbox rows are written by the server, which doesn't know the viewer's
 * language — and the same strings also go out as phone pushes and sit in the
 * database for 30 days. So rather than change what the server stores, the
 * client recognises the server's fixed templates (see notification-service,
 * approval-inbox, chat-flow, canvas approval node, device pairing) and
 * re-formats them in the current locale. Anything that doesn't match — an
 * agent's reply snippet, a task or chat title — is shown as-is.
 *
 * Keep the patterns in step with those server templates: a changed server
 * string simply stops matching and falls back to English, it never breaks.
 */
const m = defineMessages({
  workspaceChat: { id: "inbox.n.workspaceChat", defaultMessage: "Workspace chat" },
  finished: { id: "inbox.n.finished", defaultMessage: "Agent finished responding" },
  teammateReported: { id: "inbox.n.teammateReported", defaultMessage: "A teammate reported back" },
  askedQuestion: { id: "inbox.n.askedQuestion", defaultMessage: "The agent asked you a question" },
  proposedPlan: { id: "inbox.n.proposedPlan", defaultMessage: "The agent proposed a plan for review" },
  waitingApproval: { id: "inbox.n.waitingApproval", defaultMessage: "Waiting for approval · {tool}" },
  subAgentAsked: { id: "inbox.n.subAgentAsked", defaultMessage: "Sub-agent {origin} asked you a question" },
  subAgentWaiting: { id: "inbox.n.subAgentWaiting", defaultMessage: "Sub-agent {origin} is waiting for approval · {tool}" },
  taskReview: { id: "inbox.n.taskReview", defaultMessage: "Ready for review · #{number}" },
  taskDone: { id: "inbox.n.taskDone", defaultMessage: "Done · #{number}" },
  taskCancelled: { id: "inbox.n.taskCancelled", defaultMessage: "Cancelled · #{number}" },
  approvalNeeded: { id: "inbox.n.approvalNeeded", defaultMessage: "Approval needed: {name}" },
  workflowWaiting: { id: "inbox.n.workflowWaiting", defaultMessage: "Workflow is waiting for your approval at \"{node}\"." },
  devicePaired: { id: "inbox.n.devicePaired", defaultMessage: "New device paired" },
  devicePairedBody: {
    id: "inbox.n.devicePairedBody",
    defaultMessage: "{device} can now reach this machine remotely. Fingerprint {fingerprint}. Revoke it in Settings if this was not you.",
  },
  aDevice: { id: "inbox.n.aDevice", defaultMessage: "A device" },
})

const TASK_VERBS = { "Ready for review": m.taskReview, Done: m.taskDone, Cancelled: m.taskCancelled } as const

function localizeTitle(n: Notification, intl: IntlShape): string {
  const t = n.title
  if (t === "Workspace chat") return intl.formatMessage(m.workspaceChat)
  if (n.kind === "device_paired" && t === "New device paired") return intl.formatMessage(m.devicePaired)
  const approval = n.kind === "workflow_approval" ? /^Approval needed: (.+)$/.exec(t) : null
  if (approval) return intl.formatMessage(m.approvalNeeded, { name: approval[1] })
  return t
}

function localizeBody(n: Notification, intl: IntlShape): string | null {
  const b = n.body
  if (!b) return b
  switch (n.kind) {
    case "chat_complete":
      if (b === "Agent finished responding") return intl.formatMessage(m.finished)
      if (b === "A teammate reported back") return intl.formatMessage(m.teammateReported)
      return b
    case "chat_needs_input": {
      if (b === "The agent asked you a question") return intl.formatMessage(m.askedQuestion)
      if (b === "The agent proposed a plan for review") return intl.formatMessage(m.proposedPlan)
      let r = /^Sub-agent (.+) is waiting for approval · (.+)$/.exec(b)
      if (r) return intl.formatMessage(m.subAgentWaiting, { origin: r[1], tool: r[2] })
      r = /^Sub-agent (.+) asked you a question$/.exec(b)
      if (r) return intl.formatMessage(m.subAgentAsked, { origin: r[1] })
      r = /^Waiting for approval · (.+)$/.exec(b)
      if (r) return intl.formatMessage(m.waitingApproval, { tool: r[1] })
      return b
    }
    case "task_in_review":
    case "task_done":
    case "task_failed": {
      const r = /^(Ready for review|Done|Cancelled) · #(\d+)$/.exec(b)
      if (r) return intl.formatMessage(TASK_VERBS[r[1] as keyof typeof TASK_VERBS], { number: r[2] })
      return b
    }
    case "workflow_approval": {
      const r = /^Workflow is waiting for your approval at "(.+)"\.$/.exec(b)
      if (r) return intl.formatMessage(m.workflowWaiting, { node: r[1] })
      return b
    }
    case "device_paired": {
      const r = /^(.+) can now reach this machine remotely\. Fingerprint (\S+)\. Revoke it in Settings if this was not you\.$/.exec(b)
      if (!r) return b
      const device = r[1] === "A device" ? intl.formatMessage(m.aDevice) : r[1]
      return intl.formatMessage(m.devicePairedBody, { device, fingerprint: r[2] })
    }
    default:
      return b
  }
}

export function localizeNotification(n: Notification, intl: IntlShape): { title: string; body: string | null } {
  return { title: localizeTitle(n, intl), body: localizeBody(n, intl) }
}
