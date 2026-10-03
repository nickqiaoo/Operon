import { AlertTriangle, CheckCircle2, CircleSlash, Globe, Hand, Loader2, Mail, SquareTerminal, XCircle } from "lucide-react"
import { SiGithub, SiNotion } from "react-icons/si"
import type { ComponentType } from "react"
import { cn } from "@/lib/utils"
import { inboxRelativeTime } from "@/components/inbox/InboxItem"
import type { ActivityStatus, AuditDecision, AuditIcon } from "./types"

const STATUS_ICON: Record<ActivityStatus, { icon: typeof CheckCircle2; className: string; label: string }> = {
  running: { icon: Loader2, className: "text-muted-foreground animate-spin", label: "Running" },
  waiting: { icon: Hand, className: "text-status-warn", label: "Waiting for you" },
  done: { icon: CheckCircle2, className: "text-status-ok", label: "Done" },
  partial: { icon: AlertTriangle, className: "text-status-warn", label: "Done, with gaps" },
  failed: { icon: XCircle, className: "text-status-error", label: "Failed" },
  stopped: { icon: CircleSlash, className: "text-muted-foreground", label: "Stopped" },
}

export function activityStatusLabel(status: ActivityStatus): string {
  return STATUS_ICON[status].label
}

/** Status glyph in a quiet tile — the leading element of an activity row. */
export function ActivityStatusTile({ status, className }: { status: ActivityStatus; className?: string }) {
  const { icon: Icon, className: iconClass } = STATUS_ICON[status]
  return (
    <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60", className)}>
      <Icon className={cn("h-4 w-4", iconClass)} />
    </span>
  )
}

export function ActivityStatusBadge({ status }: { status: ActivityStatus }) {
  const tone =
    status === "done" ? "text-status-ok bg-status-ok/10"
    : status === "failed" ? "text-status-error bg-status-error/10"
    : status === "partial" || status === "waiting" ? "text-status-warn bg-status-warn/10"
    : "text-muted-foreground bg-muted/60"
  return <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", tone)}>{STATUS_ICON[status].label}</span>
}

const AUDIT_ICON: Record<AuditIcon, ComponentType<{ className?: string }>> = {
  globe: Globe,
  notion: SiNotion,
  github: SiGithub,
  mail: Mail,
  terminal: SquareTerminal,
}

export function AuditIconTile({ icon }: { icon: AuditIcon }) {
  const Icon = AUDIT_ICON[icon]
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-foreground/80">
      <Icon className="h-4 w-4" />
    </span>
  )
}

export const DECISION_LABEL: Record<AuditDecision, string> = {
  allowed_once: "Allowed once",
  always_allowed: "Always allowed",
  auto_allowed: "Auto-allowed",
  denied: "Denied",
}

export function formatClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "Today" / "Yesterday" / "Mon, Sep 28". */
export function dayLabel(ms: number): string {
  const diffDays = Math.round((startOfDay(Date.now()) - startOfDay(ms)) / 86_400_000)
  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b)
}

/** Assistant name and how it addresses the user, read from identity.md's frontmatter. */
export function parseIdentity(content: string): { name?: string; userName?: string } {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? ""
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm)?.[1]?.trim() || undefined
  return { name: field("name"), userName: field("user_name") }
}

/** "just now" / "5m ago" / "2h ago". */
export function timeAgo(ms: number): string {
  const rel = inboxRelativeTime(ms)
  return rel === "just now" ? rel : `${rel} ago`
}
