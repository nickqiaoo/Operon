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
import { useIntl } from "react-intl"
import type { NotificationKind } from "@/types/notification"
import { AgentIcon, activeEntryTitle } from "@/components/active/ActiveConversations"
import { dismissibleNotification, type ActiveEntry } from "@/lib/active-conversations"
import { cn } from "@/lib/utils"
import { useInboxStore } from "@/stores/inbox-store"
import { InboxApprovals } from "./InboxApprovals"
import { localizeNotification } from "./localize-notification"
import { formatRelativeTime } from "@/lib/format"

const KIND_ICON: Record<NotificationKind, typeof MessageSquare> = {
  chat_complete: MessageSquare,
  chat_needs_input: CircleAlert,
  task_in_review: Eye,
  task_done: CheckCircle2,
  task_failed: XCircle,
  sdd_gate: ShieldCheck,
  spec_gate: ShieldCheck,
  spec_blocked: CircleAlert,
  cron_done: Clock,
  workflow_approval: ShieldCheck,
  device_paired: Smartphone,
  assistant_message: Sparkles,
  assistant_approval: ShieldCheck,
}

/**
 * Symbol per kind for the native inbox sheets — the same mapping as KIND_ICON.
 * A chat row no notice speaks for uses `focusEntrySymbol`'s extra names.
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
  spec_gate: "checkmark.shield",
  spec_blocked: "exclamationmark.triangle",
  cron_done: "clock",
  workflow_approval: "checkmark.shield",
  device_paired: "iphone",
  assistant_message: "sparkles",
  assistant_approval: "checkmark.shield",
}

/** A turn in progress, in the native sheets (Android maps it in `InboxSheet.iconFor`). */
export const RUNNING_SYMBOL = "waveform"

/** The native sheets' icon for a priority row. */
export function focusEntrySymbol(entry: ActiveEntry): string {
  if (entry.group === "running") return RUNNING_SYMBOL
  if (entry.notification) return INBOX_KIND_SYMBOL[entry.notification.kind] ?? "message"
  return entry.group === "needs" ? INBOX_KIND_SYMBOL.chat_needs_input : INBOX_KIND_SYMBOL.chat_complete
}

interface FocusInboxRowProps {
  entry: ActiveEntry
  /** "Project / Workspace", from `useLocationLabel`. */
  location: string
  /** Go to the source (the conversation / the task on its board). */
  onOpen: (entry: ActiveEntry) => void
}

/**
 * One row of the phone's inbox, which lists the Focus view's priority rows: a
 * conversation (its agent, with whose turn it is as a dot) or a board / device
 * notice (its kind icon). The row is a pointer: tapping opens the source. The
 * only thing answered in place is a chat waiting on an approval.
 */
export function FocusInboxRow({ entry, location, onOpen }: FocusInboxRowProps) {
  const markRead = useInboxStore((s) => s.markRead)
  const intl = useIntl()
  const { notification } = entry
  const title = activeEntryTitle(entry, intl)
  // What the notice says, else where the conversation is.
  const body = (notification ? localizeNotification(notification, intl).body : null) || location
  const dismissible = dismissibleNotification(entry)
  const wantsYou = entry.group === "needs"
  const Icon = notification ? KIND_ICON[notification.kind] ?? MessageSquare : MessageSquare
  const approvalChatId = notification?.kind === "chat_needs_input" ? notification.chatId : null

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        data-testid="focus-inbox-row"
        data-group={entry.group}
        onClick={() => onOpen(entry)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onOpen(entry)
          }
        }}
        className={cn(
          "group relative flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-row-hover",
          entry.group === "running" && "animate-shimmer-sweep",
        )}
      >
        <span className={cn("mt-0.5 shrink-0", wantsYou ? "text-status-warn" : "text-muted-foreground")}>
          {entry.chatId != null
            ? <AgentIcon providerId={entry.providerId} group={entry.group} ringClassName="ring-background" />
            : <Icon className="size-4" />}
        </span>

        <div className="min-w-0 flex-1">
          <div className={cn("truncate text-sm", entry.group === "running" ? "text-foreground/70" : "font-medium text-foreground")}>
            {title}
          </div>
          {body && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
              {body}
            </div>
          )}
        </div>

        {/* Time, replaced by a dismiss button on hover. */}
        <div className="relative mt-0.5 w-10 shrink-0 text-right">
          {entry.at > 0 && (
            <span className={cn("text-[11px] tabular-nums text-muted-foreground/60", dismissible && "group-hover:invisible")}>
              {formatRelativeTime(intl, entry.at, { compact: true })}
            </span>
          )}
          {dismissible && (
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "inbox.dismiss", defaultMessage: "Dismiss" })}
              onClick={(e) => {
                e.stopPropagation()
                void markRead([dismissible.id])
              }}
              className="invisible absolute right-0 top-0 rounded-md p-0.5 text-muted-foreground/60 hover:bg-accent-hover hover:text-foreground group-hover:visible"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      {notification && approvalChatId != null ? (
        <div className="pb-2 pl-10 pr-3">
          <InboxApprovals chatId={approvalChatId} version={notification.updatedAt} />
        </div>
      ) : null}
    </div>
  )
}
