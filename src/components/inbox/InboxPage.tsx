import { TitlebarRow } from "@/components/app-shell/TitlebarRow"
import { FormattedMessage } from "react-intl"
import { useInboxStore } from "@/stores/inbox-store"
import type { Notification } from "@/types/notification"
import { InboxFilterTabs, InboxMarkAllRead, InboxPanel } from "./InboxPanel"

interface InboxPageProps {
  /** Deep-link to a notification's live source (task board / workspace chat). */
  onOpenSource: (n: Notification) => void
}

/**
 * The inbox, in place of the editor next to the sidebar (like the Assistant) — one list, each row
 * a pointer to its source: clicking opens the conversation or the task. There is deliberately no
 * detail pane; it only re-rendered the chat's last reply or the task's activity, a worse copy of
 * the page one click away. Approvals are the exception and are answered in the row.
 */
export function InboxPage({ onOpenSource }: InboxPageProps) {
  const markRead = useInboxStore((s) => s.markRead)

  const handleOpen = (n: Notification) => {
    if (n.readAt == null) void markRead([n.id])
    onOpenSource(n)
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* TitlebarRow clears the fixed sidebar toggle while the sidebar is narrow. */}
      <TitlebarRow className="drag-region flex h-10 shrink-0 items-center gap-2 border-b border-border/50 bg-background pr-4">
        <span className="text-xs text-muted-foreground">
          <FormattedMessage id="sidebar.inbox" defaultMessage="Inbox" />
        </span>
        <InboxFilterTabs className="no-drag ml-2" />
        <InboxMarkAllRead className="no-drag ml-auto" />
      </TitlebarRow>

      <div className="flex min-h-0 flex-1">
        <InboxPanel onItemClick={handleOpen} variant="page" />
      </div>
    </div>
  )
}
