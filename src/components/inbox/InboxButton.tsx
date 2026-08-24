import { Bell } from "lucide-react"
import { useState } from "react"
import { MobileSheet } from "@/components/mobile/MobileSheet"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useInboxStore } from "@/stores/inbox-store"
import { cn } from "@/lib/utils"
import type { Notification } from "@/types/notification"
import { InboxPanel } from "./InboxPanel"

interface InboxButtonProps {
  /** Desktop: open the full-screen inbox page. */
  onOpenPage?: () => void
  /** Mobile: deep-link on tap (no detail pane on phones). */
  onNavigate?: (n: Notification) => void
  className?: string
}

/**
 * Top-bar bell + unread indicator. Desktop click opens the full inbox page;
 * phone click opens a bottom sheet with the list (tapping a row navigates).
 * The badge is two-tier: an amber count for "needs you" (action) items, and a
 * quiet dot when there are only ordinary unread items (e.g. a finished chat).
 */
export function InboxButton({ onOpenPage, onNavigate, className }: InboxButtonProps) {
  const isMobile = useIsMobile()
  const [sheetOpen, setSheetOpen] = useState(false)
  const action = useInboxStore((s) => s.counts.action)
  const total = useInboxStore((s) => s.counts.total)

  const badge =
    action > 0 ? (
      <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-medium leading-none text-white">
        {action > 99 ? "99+" : action}
      </span>
    ) : total > 0 ? (
      <span className="absolute right-0.5 top-0.5 size-2 rounded-full bg-tint ring-2 ring-background" />
    ) : null

  const triggerClass = cn(
    "no-drag relative flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
    className,
  )

  if (isMobile) {
    const handleTap = (n: Notification) => {
      setSheetOpen(false)
      if (n.readAt == null) void useInboxStore.getState().markRead([n.id])
      onNavigate?.(n)
    }
    return (
      <>
        <button
          type="button"
          aria-label="Inbox"
          onClick={() => setSheetOpen(true)}
          className={triggerClass}
        >
          <Bell className="h-4 w-4" />
          {badge}
        </button>
        <MobileSheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
          <InboxPanel onItemClick={handleTap} />
        </MobileSheet>
      </>
    )
  }

  return (
    <button type="button" aria-label="Inbox" onClick={() => onOpenPage?.()} className={triggerClass}>
      <Bell className="h-4 w-4" />
      {badge}
    </button>
  )
}
