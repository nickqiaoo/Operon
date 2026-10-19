import { useCallback, useEffect, type UIEvent } from "react"
import { defineMessages, FormattedMessage, useIntl, type MessageDescriptor } from "react-intl"
import { CheckCheck, Inbox as InboxIcon } from "lucide-react"
import { useInboxStore, type InboxFilter } from "@/stores/inbox-store"
import type { Notification } from "@/types/notification"
import { cn } from "@/lib/utils"
import { InboxItem } from "./InboxItem"

const filterLabels = defineMessages({
  all: { id: "inbox.filter.all", defaultMessage: "All" },
  action: { id: "inbox.filter.action", defaultMessage: "Needs you" },
  info: { id: "inbox.filter.info", defaultMessage: "Done" },
})

const FILTERS: { id: InboxFilter; label: MessageDescriptor }[] = [
  { id: "all", label: filterLabels.all },
  { id: "action", label: filterLabels.action },
  { id: "info", label: filterLabels.info },
]

/** All / Needs you / Done. Shared by the sheet's header and the inbox page's top bar. */
export function InboxFilterTabs({ className }: { className?: string }) {
  const filter = useInboxStore((s) => s.filter)
  const setFilter = useInboxStore((s) => s.setFilter)
  const intl = useIntl()
  return (
    <div className={cn("flex gap-1", className)}>
      {FILTERS.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={() => void setFilter(f.id)}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs transition-colors",
            filter === f.id
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-secondary-hover hover:text-foreground",
          )}
        >
          {intl.formatMessage(f.label)}
        </button>
      ))}
    </div>
  )
}

export function InboxMarkAllRead({ className }: { className?: string }) {
  const markAllRead = useInboxStore((s) => s.markAllRead)
  const unreadCount = useInboxStore((s) => s.counts.total)
  return (
    <button
      type="button"
      disabled={unreadCount === 0}
      onClick={() => void markAllRead()}
      className={cn(
        "flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40",
        className,
      )}
    >
      <CheckCheck className="size-3.5" />
      <FormattedMessage id="inbox.markAllRead" defaultMessage="Mark all read" />
    </button>
  )
}

interface InboxPanelProps {
  onItemClick: (n: Notification) => void
  /**
   * "sheet" (default): a self-contained list with its own heading, filters and actions.
   * "page": just the list — the page's top bar carries the filters — scrolling the full
   * width (scrollbar at the window edge) with the rows held to a reading column.
   */
  variant?: "sheet" | "page"
}

/** The notification list — the body of the inbox page and the mobile sheet. */
export function InboxPanel({ onItemClick, variant = "sheet" }: InboxPanelProps) {
  const items = useInboxStore((s) => s.items)
  const filter = useInboxStore((s) => s.filter)
  const loading = useInboxStore((s) => s.loading)
  const loadingMore = useInboxStore((s) => s.loadingMore)
  const hasMore = useInboxStore((s) => s.hasMore)
  const load = useInboxStore((s) => s.load)
  const loadMore = useInboxStore((s) => s.loadMore)
  const isPage = variant === "page"

  // Refetch when the list mounts (opens); live events keep it fresh while open.
  useEffect(() => {
    void load()
  }, [load])

  const visible = items.filter((n) => (filter === "all" ? true : n.severity === filter))
  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (!hasMore || loadingMore) return
    const element = event.currentTarget
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 200) {
      void loadMore()
    }
  }, [hasMore, loadingMore, loadMore])

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {isPage ? null : (
        <>
          <div className="flex items-center justify-between px-3 pt-3 pb-2">
            <span className="text-sm font-semibold text-foreground/90"><FormattedMessage id="sidebar.inbox" defaultMessage="Inbox" /></span>
            <InboxMarkAllRead />
          </div>
          <InboxFilterTabs className="px-3 pb-2" />
        </>
      )}

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto scroll-fade-y",
          isPage ? "px-4 py-3" : "px-1.5 pb-2",
        )}
        onScroll={handleScroll}
      >
        <div className={cn(isPage && "mx-auto w-full max-w-3xl")}>
          {loading && items.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground"><FormattedMessage id="inbox.loading" defaultMessage="Loading…" /></div>
          ) : visible.length === 0 && !hasMore ? (
            <div className="m-1.5 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/50 px-4 py-10 text-center">
              <InboxIcon className="size-6 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground"><FormattedMessage id="inbox.empty" defaultMessage="You're all caught up" /></p>
            </div>
          ) : (
            visible.map((n) => (
              <InboxItem
                key={n.id}
                notification={n}
                onClick={onItemClick}
              />
            ))
          )}
          {!loading && hasMore ? (
            <div className="flex justify-center px-3 py-3">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                className="rounded-full bg-muted/70 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                {loadingMore
                  ? <FormattedMessage id="inbox.loadingMore" defaultMessage="Loading…" />
                  : <FormattedMessage id="inbox.loadMore" defaultMessage="Load more" />}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
