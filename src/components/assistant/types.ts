/**
 * View models for the Assistant page. The page is UI-only for now: everything
 * here is fed from `mock-data.ts` until the assistant runtime lands
 * (docs/assistant/design.md).
 */

/** What started an assistant message the user did not ask for. */
export type AssistantTrigger =
  | { kind: "heartbeat" }
  | { kind: "schedule"; name: string }
  | { kind: "worker"; activityId: string }

export interface AssistantMessage {
  id: string
  role: "user" | "assistant"
  text: string
  createdAt: number
  /** Set on messages the assistant sent on its own (heartbeat / schedule / a worker finishing). */
  trigger?: AssistantTrigger
  /** The worker this message reports on — hover shows "View activity". */
  activityId?: string
  /** Facts the main agent wrote to memory.md while producing this message. */
  remembered?: string[]
  /** A worker is blocked on a permission decision; rendered as the one card in the thread. */
  approval?: PendingApproval
}

export interface PendingApproval {
  id: string
  /** Human title of the action, e.g. "Edit pages in Notion". */
  title: string
  /** The worker's `intent` for the call. */
  intent: string
  icon: AuditIcon
  args: Record<string, unknown>
  /** Undefined while waiting on the user. */
  decision?: AuditDecision
}

export type ActivityStatus = "running" | "waiting" | "done" | "partial" | "failed" | "stopped"

export interface ActivityStep {
  id: string
  /** The `intent` the worker attached to the tool call. */
  label: string
  status: "running" | "done" | "failed"
  /** Tool name, input and output — shown when the step is opened. */
  tool: string
  args?: Record<string, unknown>
  /** What the tool returned (or the error), as text. */
  result?: string
  at: number
}

export interface Activity {
  id: string
  title: string
  /** One-line result (or current state while running). */
  summary: string
  status: ActivityStatus
  startedAt: number
  finishedAt?: number
  /** Longer write-up shown on the right of the drawer. */
  report?: string
  steps: ActivityStep[]
  /** Started by the heartbeat or a scheduled task rather than by the main agent. */
  source?: "heartbeat" | "schedule"
}

export type AuditDecision = "allowed_once" | "always_allowed" | "auto_allowed" | "denied"
export type AuditIcon = "globe" | "notion" | "github" | "mail" | "terminal"

export interface AuditRecord {
  id: string
  title: string
  intent: string
  icon: AuditIcon
  decision: AuditDecision
  at: number
  args: Record<string, unknown>
}

export interface StandingGrant {
  id: string
  title: string
  icon: AuditIcon
  grantedAt: number
}

export interface ScheduleRun {
  id: string
  at: number
  outcome: "silent" | "found" | "failed"
  note?: string
}

export interface ScheduleItem {
  id: string
  name: string
  /** Human cadence, e.g. "Every 30 minutes" / "Daily at 08:40". */
  cadence: string
  nextRunAt: number
  enabled: boolean
  builtin?: "heartbeat"
  runs: ScheduleRun[]
}

export type ProfileFileName = "identity" | "soul" | "memory" | "heartbeat"

export interface ProfileFile {
  name: ProfileFileName
  content: string
  updatedAt: number
  updatedBy: "assistant" | "user"
}
