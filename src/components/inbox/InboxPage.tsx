import { useState } from "react"
import { ArrowLeft } from "lucide-react"
import { useInboxStore } from "@/stores/inbox-store"
import type { Notification } from "@/types/notification"
import { InboxPanel } from "./InboxPanel"
import { InboxDetail } from "./InboxDetail"

interface InboxPageProps {
  onBack: () => void
  /** Deep-link to a notification's live source (task board / workspace chat). */
  onOpenSource: (n: Notification) => void
}

/**
 * Full-screen inbox — Linear-style two-pane: notification list on the left, the
 * selected item's detail on the right. Opened from the sidebar entry / top-bar
 * bell; portalled at the App level like the other full-screen pages.
 */
export function InboxPage({ onBack, onOpenSource }: InboxPageProps) {
  const [selected, setSelected] = useState<Notification | null>(null)
  const markRead = useInboxStore((s) => s.markRead)

  const handleSelect = (n: Notification) => {
    setSelected(n)
    if (n.readAt == null) void markRead([n.id])
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

      <div className="flex min-h-0 flex-1">
        <div className="w-[360px] shrink-0 border-r border-border/50">
          <InboxPanel onItemClick={handleSelect} selectedId={selected?.id} hideHeader />
        </div>
        <div className="min-w-0 flex-1">
          <InboxDetail notification={selected} onOpenSource={onOpenSource} />
        </div>
      </div>
    </div>
  )
}
