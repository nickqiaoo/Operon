import { useMemo } from "react"
import { defineMessages, FormattedMessage } from "react-intl"
import { CheckCheck, Inbox as InboxIcon } from "lucide-react"
import { useFocusPriority, useLocationLabel } from "@/components/active/ActiveConversations"
import { unreadNotificationIds, type ActiveEntry } from "@/lib/active-conversations"
import { useInboxUnread } from "@/lib/inbox-queries"
import { useInboxStore } from "@/stores/inbox-store"
import { FocusInboxRow } from "./InboxItem"

// Same ids as the desktop's Focus view, so both read the same in every locale.
export const focusInboxMessages = defineMessages({
  title: { id: "sidebar.focus", defaultMessage: "Focus" },
  markAllRead: { id: "focus.markAllRead", defaultMessage: "Mark all read" },
  empty: { id: "focus.nothingPending", defaultMessage: "Nothing waiting on you" },
  loading: { id: "inbox.loading", defaultMessage: "Loading…" },
})

/**
 * The phone's inbox rows: the desktop Focus view's priority section, minus a
 * new chat's first turn, which has no id to open it by from here. The
 * conversations by day are left out; the Chats tab already lists them.
 */
export function usePhoneFocusEntries(): ActiveEntry[] {
  const priority = useFocusPriority()
  return useMemo(() => priority.filter((entry) => entry.chatId != null || entry.notification != null), [priority])
}

interface InboxPanelProps {
  onOpen: (entry: ActiveEntry) => void
}

/**
 * The phone's inbox sheet: what wants the user now (an approval or question,
 * an unread reply, a running turn, an unread board or device notice). Opening
 * a row reads it, which takes it off the list; there is no read history.
 */
export function InboxPanel({ onOpen }: InboxPanelProps) {
  const entries = usePhoneFocusEntries()
  const locationOf = useLocationLabel()
  const markRead = useInboxStore((s) => s.markRead)
  const { isPending } = useInboxUnread()
  const unreadIds = unreadNotificationIds(entries)

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <span className="text-sm font-semibold text-foreground/90"><FormattedMessage {...focusInboxMessages.title} /></span>
        <button
          type="button"
          data-testid="focus-inbox-mark-all-read"
          disabled={unreadIds.length === 0}
          onClick={() => void markRead(unreadIds)}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <CheckCheck className="size-3.5" />
          <FormattedMessage {...focusInboxMessages.markAllRead} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y px-1.5 pb-2">
        {isPending && entries.length === 0 ? (
          <div className="px-3 py-10 text-center text-sm text-muted-foreground"><FormattedMessage {...focusInboxMessages.loading} /></div>
        ) : entries.length === 0 ? (
          <div className="m-1.5 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/50 px-4 py-10 text-center">
            <InboxIcon className="size-6 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground"><FormattedMessage {...focusInboxMessages.empty} /></p>
          </div>
        ) : (
          entries.map((entry) => (
            <FocusInboxRow key={entry.key} entry={entry} location={locationOf(entry)} onOpen={onOpen} />
          ))
        )}
      </div>
    </div>
  )
}
