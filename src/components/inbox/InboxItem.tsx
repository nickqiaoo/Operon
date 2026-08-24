import {
  CheckCircle2,
  CircleAlert,
  Clock,
  Eye,
  MessageSquare,
  ShieldCheck,
  X,
  XCircle,
} from "lucide-react"
import type { Notification, NotificationKind } from "@/types/notification"
import { cn } from "@/lib/utils"
import { useInboxStore } from "@/stores/inbox-store"

const KIND_ICON: Record<NotificationKind, typeof MessageSquare> = {
  chat_complete: MessageSquare,
  chat_needs_input: CircleAlert,
  task_in_review: Eye,
  task_done: CheckCircle2,
  task_failed: XCircle,
  sdd_gate: ShieldCheck,
  cron_done: Clock,
}

export function inboxRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  const s = Math.floor(diff / 1000)
  if (s < 60) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return `${Math.floor(d / 7)}w`
}

interface InboxItemProps {
  notification: Notification
  onClick: (n: Notification) => void
  /** Highlight as the active row (three-pane page). */
  selected?: boolean
}

/** One inbox list row: kind icon + title/body + relative time, hover to dismiss. */
export function InboxItem({ notification, onClick, selected }: InboxItemProps) {
  const archive = useInboxStore((s) => s.archive)
  const Icon = KIND_ICON[notification.kind] ?? MessageSquare
  const unread = notification.readAt == null
  const isAction = notification.severity === "action"

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick(notification)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onClick(notification)
        }
      }}
      className={cn(
        "group relative flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
        selected ? "bg-muted/70" : "hover:bg-muted/50",
        !selected && unread && "bg-muted/20",
      )}
    >
      <span
        className={cn(
          "mt-0.5 shrink-0",
          isAction ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {unread && (
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                isAction ? "bg-amber-500" : "bg-tint",
              )}
            />
          )}
          <span
            className={cn(
              "truncate text-sm",
              unread ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {notification.title}
          </span>
        </div>
        {notification.body && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
            {notification.body}
          </div>
        )}
      </div>

      {/* Time, replaced by a dismiss button on hover. */}
      <div className="relative mt-0.5 w-10 shrink-0 text-right">
        <span className="text-[11px] tabular-nums text-muted-foreground/60 group-hover:invisible">
          {inboxRelativeTime(notification.createdAt)}
        </span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={(e) => {
            e.stopPropagation()
            void archive(notification.id)
          }}
          className="invisible absolute right-0 top-0 rounded-md p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-foreground group-hover:visible"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
