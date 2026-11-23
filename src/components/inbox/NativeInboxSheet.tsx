import { useEffect, useMemo, useRef, type RefObject } from "react"
import { useIntl, type IntlShape } from "react-intl"
import { activeEntryTitle, useLocationLabel } from "@/components/active/ActiveConversations"
import { dismissibleNotification, entryNotificationIds, unreadNotificationIds, type ActiveEntry } from "@/lib/active-conversations"
import { formatRelativeTime } from "@/lib/format"
import { useInboxUnread } from "@/lib/inbox-queries"
import { hasNativeTabBar, NativeShell, type NativeInboxState } from "@/lib/native"
import { useInboxStore } from "@/stores/inbox-store"
import { openFocusEntry } from "./InboxButton"
import { focusEntrySymbol } from "./InboxItem"
import { focusInboxMessages, usePhoneFocusEntries } from "./InboxPanel"
import { localizeNotification } from "./localize-notification"

// The phone inbox as a native sheet (InboxSheet.swift / InboxSheet.kt), with
// the same rows as the web InboxPanel. While the sheet is up every change is
// pushed over as a fresh snapshot; every control in it comes back as an
// intent that runs here.

export interface NativeInboxHandle {
  /** Presents the sheet; resolves false when there is no native one, so the caller can fall back to the web sheet. */
  open: () => Promise<boolean>
}

function labels(intl: IntlShape) {
  return {
    title: intl.formatMessage(focusInboxMessages.title),
    // No filters: the native sheets draw no segmented control for an empty list.
    filters: [],
    markAllRead: intl.formatMessage(focusInboxMessages.markAllRead),
    empty: intl.formatMessage(focusInboxMessages.empty),
    loading: intl.formatMessage(focusInboxMessages.loading),
    loadMore: "",
  }
}

interface NativeInboxSheetProps {
  /** Filled with the sheet's controls once mounted. */
  handle: RefObject<NativeInboxHandle | null>
  onOpen: (entry: ActiveEntry) => void
  /** Whether anything wants the user, for the native bar's bell. */
  onAttentionChange: (attention: boolean) => void
}

/**
 * A leaf that renders nothing: the Focus rows change on every turn and inbox
 * event, and only this has to re-render for it, not the whole phone shell.
 */
export function NativeInboxSheet({ handle, onOpen, onAttentionChange }: NativeInboxSheetProps) {
  const intl = useIntl()
  const entries = usePhoneFocusEntries()
  const locationOf = useLocationLabel()
  const { isPending } = useInboxUnread()

  // The native rows are keyed by a number; entries by a string ("chat:12", "notification:7").
  const rowIds = useRef(new Map<string, number>())
  const snapshot = useMemo(() => {
    const byId = new Map<number, ActiveEntry>()
    const items: NativeInboxState["items"] = entries.map((entry) => {
      let id = rowIds.current.get(entry.key)
      if (id == null) {
        id = rowIds.current.size + 1
        rowIds.current.set(entry.key, id)
      }
      byId.set(id, entry)
      const body = (entry.notification ? localizeNotification(entry.notification, intl).body : null) || locationOf(entry)
      return {
        id,
        title: activeEntryTitle(entry, intl),
        body: body || undefined,
        time: entry.at > 0 ? formatRelativeTime(intl, entry.at, { compact: true }) : "",
        symbol: focusEntrySymbol(entry),
        action: entry.group === "needs",
        unread: entry.group === "needs" || entry.group === "done",
        dismissible: dismissibleNotification(entry) != null,
      }
    })
    const unreadIds = unreadNotificationIds(entries)
    const state: NativeInboxState = {
      filter: "",
      items,
      loading: isPending && entries.length === 0,
      loadingMore: false,
      hasMore: false,
      unreadCount: unreadIds.length,
    }
    return { state, byId, unreadIds }
  }, [entries, intl, isPending, locationOf])

  const latest = useRef({ snapshot, intl, onOpen })
  latest.current = { snapshot, intl, onOpen }
  const presented = useRef(false)

  useEffect(() => {
    if (!hasNativeTabBar()) return
    const handles = [
      NativeShell.addListener("inboxAction", ({ action, id }) => {
        const { snapshot: current, onOpen: open } = latest.current
        const entry = id != null ? current.byId.get(id) : undefined
        const { markRead } = useInboxStore.getState()
        if (action === "open" && entry) {
          void NativeShell.dismissInboxSheet().catch(() => {})
          openFocusEntry(entry, open)
        } else if (action === "archive" && entry) {
          if (dismissibleNotification(entry)) void markRead(entryNotificationIds(entry))
        } else if (action === "markAllRead") {
          void markRead(current.unreadIds)
        }
      }),
      NativeShell.addListener("inboxSheetDismissed", () => {
        presented.current = false
      }),
    ]
    return () => {
      for (const listener of handles) void listener.then((h) => h.remove()).catch(() => {})
    }
  }, [])

  // Mirror the rows into the sheet while it is up.
  useEffect(() => {
    if (presented.current) void NativeShell.updateInboxSheet({ state: snapshot.state }).catch(() => {})
  }, [snapshot])

  useEffect(() => {
    handle.current = {
      open: async () => {
        if (!hasNativeTabBar()) return false
        try {
          const { snapshot: current, intl: currentIntl } = latest.current
          await NativeShell.presentInboxSheet({ labels: labels(currentIntl), state: current.state })
          presented.current = true
          // Rows may have changed between the snapshot sent and the sheet coming up.
          void NativeShell.updateInboxSheet({ state: latest.current.snapshot.state }).catch(() => {})
          return true
        } catch {
          return false
        }
      },
    }
    return () => {
      handle.current = null
    }
  }, [handle])

  const attention = entries.some((entry) => entry.group === "needs" || entry.group === "done")
  useEffect(() => {
    onAttentionChange(attention)
  }, [attention, onAttentionChange])

  return null
}
