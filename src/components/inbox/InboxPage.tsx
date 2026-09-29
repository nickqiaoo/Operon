import { ArrowLeft } from "lucide-react"
import { useInboxStore } from "@/stores/inbox-store"
import type { Notification } from "@/types/notification"
import { InboxPanel } from "./InboxPanel"

interface InboxPageProps {
  onBack: () => void
  /** Deep-link to a notification's live source (task board / workspace chat). */
  onOpenSource: (n: Notification) => void
}

/**
 * Full-screen inbox — one list, each row a pointer to its source: clicking opens
 * the conversation or the task. There is deliberately no detail pane; it only
 * re-rendered the chat's last reply or the task's activity, a worse copy of the
 * page one click away. Approvals are the exception and are answered in the row.
 */
export function InboxPage({ onBack, onOpenSource }: InboxPageProps) {
  const markRead = useInboxStore((s) => s.markRead)

  const handleOpen = (n: Notification) => {
    if (n.readAt == null) void markRead([n.id])
    onOpenSource(n)
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div
        className={`drag-region flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background pr-3 ${
          __APP_TARGET__ !== "web" ? "pl-20" : "pl-3"
        }`}
      >
        <button
          type="button"
          onClick={onBack}
          title="Back"
          className="no-drag flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium text-foreground/90">Inbox</span>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1">
        <InboxPanel onItemClick={handleOpen} hideHeader />
      </div>
    </div>
  )
}
