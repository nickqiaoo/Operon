import { useCallback, useEffect, useRef } from "react"
import { defineMessages, useIntl, type IntlShape } from "react-intl"
import { hasNativeTabBar, NativeShell, type NativeInboxState } from "@/lib/native"
import { useInboxStore } from "@/stores/inbox-store"
import { isAssistantNotification } from "@/types/notification"
import { INBOX_KIND_SYMBOL, inboxRelativeTime } from "@/components/inbox/InboxItem"
import { localizeNotification } from "@/components/inbox/localize-notification"
import type { Notification } from "@/types/notification"

// The inbox as a native sheet (InboxSheet.swift / InboxSheet.kt). The store stays the
// only owner: while the sheet is up every store change is pushed over as a
// fresh snapshot, and every control in the sheet comes back as an intent that
// runs the same store action the web InboxPanel would.

// Same message ids the web InboxPanel uses, so both read the same in every locale.
const m = defineMessages({
  title: { id: "sidebar.inbox", defaultMessage: "Inbox" },
  all: { id: "inbox.filter.all", defaultMessage: "All" },
  action: { id: "inbox.filter.action", defaultMessage: "Needs you" },
  info: { id: "inbox.filter.info", defaultMessage: "Done" },
  markAllRead: { id: "inbox.markAllRead", defaultMessage: "Mark all read" },
  empty: { id: "inbox.empty", defaultMessage: "You're all caught up" },
  loading: { id: "inbox.loadingMore", defaultMessage: "Loading…" },
  loadMore: { id: "inbox.loadMore", defaultMessage: "Load more" },
})

function labels(intl: IntlShape) {
  return {
    title: intl.formatMessage(m.title),
    filters: [
      { id: "all", label: intl.formatMessage(m.all) },
      { id: "action", label: intl.formatMessage(m.action) },
      { id: "info", label: intl.formatMessage(m.info) },
    ],
    markAllRead: intl.formatMessage(m.markAllRead),
    empty: intl.formatMessage(m.empty),
    loading: intl.formatMessage(m.loading),
    loadMore: intl.formatMessage(m.loadMore),
  }
}

function snapshot(intl: IntlShape): NativeInboxState {
  const s = useInboxStore.getState()
  const visible = s.items.filter((n) => !isAssistantNotification(n) && (s.filter === "all" || n.severity === s.filter))
  return {
    filter: s.filter,
    items: visible.map((n) => {
      const { title, body } = localizeNotification(n, intl)
      return {
      id: n.id,
      title,
      body: body ?? undefined,
      time: inboxRelativeTime(n.createdAt, intl),
      symbol: INBOX_KIND_SYMBOL[n.kind] ?? "message",
      action: n.severity === "action",
      unread: n.readAt == null,
      }
    }),
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
  const intl = useIntl()
  const intlRef = useRef(intl)
  intlRef.current = intl
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
      if (presented.current) void NativeShell.updateInboxSheet({ state: snapshot(intlRef.current) }).catch(() => {})
    })
    return () => {
      unsubscribe()
      for (const handle of handles) void handle.then((h) => h.remove()).catch(() => {})
    }
  }, [])

  return useCallback(async () => {
    if (!hasNativeTabBar()) return false
    try {
      await NativeShell.presentInboxSheet({ labels: labels(intlRef.current), state: snapshot(intlRef.current) })
      presented.current = true
      // Same as InboxPanel mounting: refetch the first page.
      void useInboxStore.getState().load()
      return true
    } catch {
      return false
    }
  }, [])
}
