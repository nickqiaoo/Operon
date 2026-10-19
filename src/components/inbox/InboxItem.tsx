import {
  CheckCircle2,
  CircleAlert,
  Clock,
  Eye,
  MessageSquare,
  ShieldCheck,
  Smartphone,
  Sparkles,
  X,
  XCircle,
} from "lucide-react"
import { defineMessages, useIntl, type IntlShape } from "react-intl"
import type { Notification, NotificationKind } from "@/types/notification"
import { cn } from "@/lib/utils"
import { useInboxStore } from "@/stores/inbox-store"
import { InboxApprovals } from "./InboxApprovals"
import { localizeNotification } from "./localize-notification"

const KIND_ICON: Record<NotificationKind, typeof MessageSquare> = {
  chat_complete: MessageSquare,
  chat_needs_input: CircleAlert,
  task_in_review: Eye,
  task_done: CheckCircle2,
  task_failed: XCircle,
  sdd_gate: ShieldCheck,
  cron_done: Clock,
  workflow_approval: ShieldCheck,
  device_paired: Smartphone,
  assistant_message: Sparkles,
  assistant_approval: ShieldCheck,
}

/**
 * Symbol per kind for the native inbox sheets — the same mapping as KIND_ICON.
 *
 * Named in SF Symbols because iOS can use these directly; the Android shell
 * translates them to its own icons (`InboxSheet.iconFor`). One vocabulary with
 * a translation on one side beats two tables to keep in step.
 */
export const INBOX_KIND_SYMBOL: Record<NotificationKind, string> = {
  chat_complete: "message",
  chat_needs_input: "exclamationmark.circle",
  task_in_review: "eye",
  task_done: "checkmark.circle",
  task_failed: "xmark.circle",
  sdd_gate: "checkmark.shield",
  cron_done: "clock",
  workflow_approval: "checkmark.shield",
  device_paired: "iphone",
  assistant_message: "sparkles",
  assistant_approval: "checkmark.shield",
}

const timeMessages = defineMessages({
  justNow: { id: "inbox.time.justNow", defaultMessage: "just now" },
  minutes: { id: "inbox.time.minutes", defaultMessage: "{n}m" },
  hours: { id: "inbox.time.hours", defaultMessage: "{n}h" },
  days: { id: "inbox.time.days", defaultMessage: "{n}d" },
  weeks: { id: "inbox.time.weeks", defaultMessage: "{n}w" },
})

export function inboxRelativeTime(ms: number, intl: IntlShape): string {
  const diff = Date.now() - ms
  const s = Math.floor(diff / 1000)
  if (s < 60) return intl.formatMessage(timeMessages.justNow)
  const m = Math.floor(s / 60)
  if (m < 60) return intl.formatMessage(timeMessages.minutes, { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return intl.formatMessage(timeMessages.hours, { n: h })
  const d = Math.floor(h / 24)
  if (d < 7) return intl.formatMessage(timeMessages.days, { n: d })
  return intl.formatMessage(timeMessages.weeks, { n: Math.floor(d / 7) })
}

interface InboxItemProps {
  notification: Notification
  /** Jump to the source (the conversation / the task on its board). */
  onClick: (n: Notification) => void
}

/**
 * One inbox list row: kind icon + title/body + relative time, hover to dismiss.
 * The row is a pointer, not a copy — clicking it opens the source. The only
 * thing answered in place is a chat waiting on an approval.
 */
export function InboxItem({ notification, onClick }: InboxItemProps) {
  const archive = useInboxStore((s) => s.archive)
  const intl = useIntl()
  const { title, body } = localizeNotification(notification, intl)
  const Icon = KIND_ICON[notification.kind] ?? MessageSquare
  const unread = notification.readAt == null
  const isAction = notification.severity === "action"
  // Not gated on unread: "Mark all read" must not hide an approval still
  // waiting. A row whose asks were all answered fetches an empty list.
  const awaitingApproval = notification.kind === "chat_needs_input" && notification.chatId != null

  return (
    <div>
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
          "group relative flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-row-hover",
          unread && "bg-muted/20",
        )}
      >
        <span
          className={cn(
            "mt-0.5 shrink-0",
            isAction ? "text-status-warn" : "text-muted-foreground",
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
                  isAction ? "bg-accent-warm" : "bg-tint",
                )}
              />
            )}
            <span
              className={cn(
                "truncate text-sm",
                unread ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {title}
            </span>
          </div>
          {body && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
              {body}
            </div>
          )}
        </div>

        {/* Time, replaced by a dismiss button on hover. */}
        <div className="relative mt-0.5 w-10 shrink-0 text-right">
          <span className="text-[11px] tabular-nums text-muted-foreground/60 group-hover:invisible">
            {inboxRelativeTime(notification.createdAt, intl)}
          </span>
          <button
            type="button"
            aria-label={intl.formatMessage({ id: "inbox.dismiss", defaultMessage: "Dismiss" })}
            onClick={(e) => {
              e.stopPropagation()
              void archive(notification.id)
            }}
            className="invisible absolute right-0 top-0 rounded-md p-0.5 text-muted-foreground/60 hover:bg-accent-hover hover:text-foreground group-hover:visible"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
      {awaitingApproval ? (
        <div className="pb-2 pl-10 pr-3">
          <InboxApprovals chatId={notification.chatId!} version={notification.updatedAt} />
        </div>
      ) : null}
    </div>
  )
}
