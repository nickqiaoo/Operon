import { PanelLeft } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { cn } from "@/lib/utils"
import { useInboxStore } from "@/stores/inbox-store"
import type { Notification } from "@/types/notification"
import { InboxFilterTabs, InboxMarkAllRead, InboxPanel } from "./InboxPanel"

interface InboxPageProps {
  /** The left sidebar is collapsed: make room for the window controls and offer to expand it. */
  sidebarCollapsed: boolean
  onExpandSidebar: () => void
  /** Deep-link to a notification's live source (task board / workspace chat). */
  onOpenSource: (n: Notification) => void
}

/**
 * The inbox, in place of the editor next to the sidebar (like the Assistant) — one list, each row
 * a pointer to its source: clicking opens the conversation or the task. There is deliberately no
 * detail pane; it only re-rendered the chat's last reply or the task's activity, a worse copy of
 * the page one click away. Approvals are the exception and are answered in the row.
 */
export function InboxPage({ sidebarCollapsed, onExpandSidebar, onOpenSource }: InboxPageProps) {
  const intl = useIntl()
  const markRead = useInboxStore((s) => s.markRead)

  const handleOpen = (n: Notification) => {
    if (n.readAt == null) void markRead([n.id])
    onOpenSource(n)
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div
        className={cn(
          "drag-region flex h-10 shrink-0 items-center gap-2 border-b border-border/50 bg-background pr-4",
          sidebarCollapsed && __APP_TARGET__ !== "web" ? "pl-20" : "pl-4",
        )}
      >
        {sidebarCollapsed && (
          <button
            type="button"
            onClick={onExpandSidebar}
            title={intl.formatMessage({ id: "assistant.expandSidebar", defaultMessage: "Expand sidebar" })}
            className="no-drag flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}
        <span className="text-xs text-muted-foreground">
          <FormattedMessage id="sidebar.inbox" defaultMessage="Inbox" />
        </span>
        <InboxFilterTabs className="no-drag ml-2" />
        <InboxMarkAllRead className="no-drag ml-auto" />
      </div>

      <div className="flex min-h-0 flex-1">
        <InboxPanel onItemClick={handleOpen} variant="page" />
      </div>
    </div>
  )
}
