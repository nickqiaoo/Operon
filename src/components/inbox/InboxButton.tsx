import { Bell } from "lucide-react"
import { useState } from "react"
import { useIntl } from "react-intl"
import { MobileSheet } from "@/components/mobile/MobileSheet"
import { activeAttentionCounts, type ActiveEntry } from "@/lib/active-conversations"
import { cn } from "@/lib/utils"
import { useInboxStore } from "@/stores/inbox-store"
import { InboxPanel, usePhoneFocusEntries } from "./InboxPanel"

/** Go to a row, reading the notice behind it so it leaves the list. */
export function openFocusEntry(entry: ActiveEntry, onOpen: (entry: ActiveEntry) => void): void {
  const { notification } = entry
  if (notification && notification.readAt == null) void useInboxStore.getState().markRead([notification.id])
  onOpen(entry)
}

/**
 * What the bell says: an amber count for rows waiting on the user, a quiet
 * dot when there are only unread replies and notices. A running turn alone
 * lights nothing, as on the desktop rail.
 */
export function useFocusAttention(): { needs: number; done: number } {
  return activeAttentionCounts(usePhoneFocusEntries())
}

/**
 * The phone inbox: a bottom sheet with the list; tapping a row navigates.
 * Split from the bell so the iOS shell, whose bell is a native bar button,
 * can open the same sheet without rendering a web bell.
 */
export function MobileInboxSheet({
  open,
  onClose,
  onOpen,
}: {
  open: boolean
  onClose: () => void
  onOpen: (entry: ActiveEntry) => void
}) {
  const handleTap = (entry: ActiveEntry) => {
    onClose()
    openFocusEntry(entry, onOpen)
  }
  return (
    <MobileSheet open={open} onClose={onClose}>
      <InboxPanel onOpen={handleTap} />
    </MobileSheet>
  )
}

interface InboxButtonProps {
  /** Deep-link on tap (no detail pane on phones). */
  onOpen: (entry: ActiveEntry) => void
  /** Open the inbox some other way (the packaged apps' native sheet) instead of the web one. */
  onOpenSheet?: () => void
  className?: string
}

/** The phone's top-bar bell: opens the inbox sheet, badged with what wants the user. */
export function InboxButton({ onOpen, onOpenSheet, className }: InboxButtonProps) {
  const intl = useIntl()
  const inboxLabel = intl.formatMessage({ id: "sidebar.inbox", defaultMessage: "Inbox" })
  const [sheetOpen, setSheetOpen] = useState(false)
  const { needs, done } = useFocusAttention()

  return (
    <>
      <button
        type="button"
        aria-label={inboxLabel}
        data-testid="mobile-inbox-button"
        onClick={() => (onOpenSheet ? onOpenSheet() : setSheetOpen(true))}
        className={cn(
          "no-drag relative flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent-hover hover:text-foreground",
          className,
        )}
      >
        <Bell className="h-4 w-4" />
        {needs > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-warm px-1 text-[10px] font-medium leading-none text-white">
            {needs > 99 ? "99+" : needs}
          </span>
        ) : done > 0 ? (
          <span className="absolute right-0.5 top-0.5 size-2 rounded-full bg-tint ring-2 ring-background" />
        ) : null}
      </button>
      <MobileInboxSheet open={sheetOpen} onClose={() => setSheetOpen(false)} onOpen={onOpen} />
    </>
  )
}
