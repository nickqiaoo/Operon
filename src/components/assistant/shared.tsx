import { AlertTriangle, AppWindow, CheckCircle2, CircleSlash, FileText, Globe, Hand, Loader2, SquareTerminal, Wrench, XCircle } from "lucide-react"
import type { ComponentType } from "react"
import { FormattedMessage } from "react-intl"
import { cn } from "@/lib/utils"
import type { ActivityStatus, ApprovalIcon } from "./types"
import { ACTIVITY_STATUS_MESSAGES } from "./assistant-i18n"

const STATUS_ICON: Record<ActivityStatus, { icon: typeof CheckCircle2; className: string }> = {
  running: { icon: Loader2, className: "text-muted-foreground animate-spin" },
  waiting: { icon: Hand, className: "text-status-warn" },
  done: { icon: CheckCircle2, className: "text-status-ok" },
  partial: { icon: AlertTriangle, className: "text-status-warn" },
  failed: { icon: XCircle, className: "text-status-error" },
  stopped: { icon: CircleSlash, className: "text-muted-foreground" },
}

/** Status glyph in a quiet tile — the leading element of an activity row. */
export function ActivityStatusTile({ status, large, className }: { status: ActivityStatus; large?: boolean; className?: string }) {
  const { icon: Icon, className: iconClass } = STATUS_ICON[status]
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center bg-muted/60",
        large ? "size-12 rounded-full" : "h-8 w-8 rounded-lg",
        className,
      )}
    >
      <Icon className={cn(large ? "size-5" : "h-4 w-4", iconClass)} />
    </span>
  )
}

export function ActivityStatusBadge({ status, large }: { status: ActivityStatus; large?: boolean }) {
  const tone =
    status === "done" ? "text-status-ok bg-status-ok/10"
    : status === "failed" ? "text-status-error bg-status-error/10"
    : status === "partial" || status === "waiting" ? "text-status-warn bg-status-warn/10"
    : "text-muted-foreground bg-muted/60"
  return (
    <span className={cn("font-medium", large ? "rounded-md px-2 py-1 text-sm" : "rounded px-1.5 py-0.5 text-[11px]", tone)}>
      <FormattedMessage {...ACTIVITY_STATUS_MESSAGES[status]} />
    </span>
  )
}

const APPROVAL_ICON: Record<ApprovalIcon, ComponentType<{ className?: string }>> = {
  globe: Globe,
  app: AppWindow,
  file: FileText,
  terminal: SquareTerminal,
  tool: Wrench,
}

export function AuditIconTile({ icon }: { icon: ApprovalIcon }) {
  const Icon = APPROVAL_ICON[icon] ?? Wrench
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-foreground/80">
      <Icon className="h-4 w-4" />
    </span>
  )
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

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b)
}

export { parseIdentity } from "@shared/assistant"
