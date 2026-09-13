import { useCallback, useEffect, useRef } from "react"
import { hasNativeTabBar, NativeShell, type NativeInboxState } from "@/lib/native"
import { useInboxStore } from "@/stores/inbox-store"
import { INBOX_KIND_SYMBOL, inboxRelativeTime } from "@/components/inbox/InboxItem"
import type { Notification } from "@/types/notification"

// The inbox as a native sheet (InboxSheet.swift / InboxSheet.kt). The store stays the
// only owner: while the sheet is up every store change is pushed over as a
// fresh snapshot, and every control in the sheet comes back as an intent that
// runs the same store action the web InboxPanel would.

// Same strings the web InboxPanel hardcodes.
const LABELS = {
  title: "Inbox",
  filters: [
    { id: "all", label: "All" },
    { id: "action", label: "Needs you" },
    { id: "info", label: "Done" },
  ],
  markAllRead: "Mark all read",
  empty: "You're all caught up",
  loading: "Loading…",
  loadMore: "Load more",
}

function snapshot(): NativeInboxState {
  const s = useInboxStore.getState()
  const visible = s.items.filter((n) => (s.filter === "all" ? true : n.severity === s.filter))
  return {
    filter: s.filter,
    items: visible.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body ?? undefined,
      time: inboxRelativeTime(n.createdAt),
      symbol: INBOX_KIND_SYMBOL[n.kind] ?? "message",
      action: n.severity === "action",
      unread: n.readAt == null,
    })),
    loading: s.loading,
    loadingMore: s.loadingMore,
    hasMore: s.hasMore,
    unreadCount: s.counts.total,
  }
}

/**
 * Returns `open()`, which presents the sheet, or resolves false when the
 * native sheet is unavailable so the caller can fall back to the web one.
 */
export function useNativeInboxSheet(onNavigate: (n: Notification) => void): () => Promise<boolean> {
  const navigate = useRef(onNavigate)
  navigate.current = onNavigate
  const presented = useRef(false)

  useEffect(() => {
    if (!hasNativeTabBar()) return
    const handles = [
      NativeShell.addListener("inboxAction", ({ action, id, filter }) => {
        const store = useInboxStore.getState()
        if (action === "open" && id != null) {
          const n = store.items.find((item) => item.id === id)
          if (!n) return
          void NativeShell.dismissInboxSheet().catch(() => {})
          if (n.readAt == null) void store.markRead([n.id])
          navigate.current(n)
        } else if (action === "archive" && id != null) {
          void store.archive(id)
        } else if (action === "markAllRead") {
          void store.markAllRead()
        } else if (action === "filter" && (filter === "all" || filter === "action" || filter === "info")) {
          void store.setFilter(filter)
        } else if (action === "loadMore") {
          void store.loadMore()
        }
      }),
      NativeShell.addListener("inboxSheetDismissed", () => {
        presented.current = false
      }),
    ]
    // Mirror the store into the sheet while it is up.
    const unsubscribe = useInboxStore.subscribe(() => {
      if (presented.current) void NativeShell.updateInboxSheet({ state: snapshot() }).catch(() => {})
    })
    return () => {
      unsubscribe()
      for (const handle of handles) void handle.then((h) => h.remove()).catch(() => {})
    }
  }, [])

  return useCallback(async () => {
    if (!hasNativeTabBar()) return false
    try {
      await NativeShell.presentInboxSheet({ labels: LABELS, state: snapshot() })
      presented.current = true
      // Same as InboxPanel mounting: refetch the first page.
      void useInboxStore.getState().load()
      return true
    } catch {
      return false
    }
  }, [])
}
