import { useCallback, useEffect, type UIEvent } from "react"
import { CheckCheck, Inbox as InboxIcon } from "lucide-react"
import { useInboxStore, type InboxFilter } from "@/stores/inbox-store"
import type { Notification } from "@/types/notification"
import { cn } from "@/lib/utils"
import { InboxItem } from "./InboxItem"

const FILTERS: { id: InboxFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "action", label: "Needs you" },
  { id: "info", label: "Done" },
]

interface InboxPanelProps {
  onItemClick: (n: Notification) => void
  /** Highlighted row id in the three-pane page (undefined in the mobile sheet). */
  selectedId?: number
  /** Hide the internal "Inbox" heading when the shell already shows a title. */
  hideHeader?: boolean
}

/** The notification list — the middle column of the page and the mobile sheet body. */
export function InboxPanel({ onItemClick, selectedId, hideHeader }: InboxPanelProps) {
  const items = useInboxStore((s) => s.items)
  const filter = useInboxStore((s) => s.filter)
  const loading = useInboxStore((s) => s.loading)
  const loadingMore = useInboxStore((s) => s.loadingMore)
  const hasMore = useInboxStore((s) => s.hasMore)
  const setFilter = useInboxStore((s) => s.setFilter)
  const load = useInboxStore((s) => s.load)
  const loadMore = useInboxStore((s) => s.loadMore)
  const markAllRead = useInboxStore((s) => s.markAllRead)
  const unreadCount = useInboxStore((s) => s.counts.total)

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
      <div
        className={cn(
          "flex items-center justify-between px-3 pt-3 pb-2",
          hideHeader && "pt-2",
        )}
      >
        {hideHeader ? <span /> : <span className="text-sm font-semibold text-foreground/90">Inbox</span>}
        <button
          type="button"
          disabled={unreadCount === 0}
          onClick={() => void markAllRead()}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <CheckCheck className="size-3.5" /> Mark all read
        </button>
      </div>

      <div className="flex gap-1 px-3 pb-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => void setFilter(f.id)}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs transition-colors",
              filter === f.id
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/50",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
        onScroll={handleScroll}
      >
        {loading && items.length === 0 ? (
          <div className="px-3 py-10 text-center text-sm text-muted-foreground">Loading…</div>
        ) : visible.length === 0 && !hasMore ? (
          <div className="m-1.5 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/50 px-4 py-10 text-center">
            <InboxIcon className="size-6 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">You&apos;re all caught up</p>
          </div>
        ) : (
          visible.map((n) => (
            <InboxItem
              key={n.id}
              notification={n}
              onClick={onItemClick}
              selected={selectedId === n.id}
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
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
