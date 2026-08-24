import { create } from 'zustand'
import { api } from '@/lib/api'
import type { InboxEvent, Notification, UnreadCounts } from '@/types/notification'

export type InboxFilter = 'all' | 'action' | 'info'

const PAGE_SIZE = 50
let loadGeneration = 0

interface InboxStore {
  /** Visible (non-archived) notifications, newest first. */
  items: Notification[]
  counts: UnreadCounts
  filter: InboxFilter
  loading: boolean
  loaded: boolean
  loadingMore: boolean
  hasMore: boolean
  nextCursor: number | null

  setFilter: (filter: InboxFilter) => Promise<void>
  /** Fetch the visible feed (first page). Called when the panel opens. */
  load: () => Promise<void>
  /** Append the next cursor page for the active filter. */
  loadMore: () => Promise<void>
  markRead: (ids: number[]) => Promise<void>
  markReadBySourceKeys: (sourceKeys: string[]) => Promise<void>
  markAllRead: () => Promise<void>
  archive: (id: number) => Promise<void>
  /** Apply a live event from the SSE stream. */
  applyEvent: (event: InboxEvent) => void
}

function sortByCreated(items: Notification[]): Notification[] {
  return [...items].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
}

function upsert(items: Notification[], next: Notification): Notification[] {
  const exists = items.some((n) => n.id === next.id)
  const merged = exists ? items.map((n) => (n.id === next.id ? next : n)) : [next, ...items]
  return sortByCreated(merged)
}

function appendUnique(items: Notification[], older: Notification[]): Notification[] {
  const seen = new Set(items.map((notification) => notification.id))
  return sortByCreated([
    ...items,
    ...older.filter((notification) => !seen.has(notification.id)),
  ])
}

function severityForFilter(filter: InboxFilter): 'action' | 'info' | undefined {
  return filter === 'all' ? undefined : filter
}

export const useInboxStore = create<InboxStore>((set, get) => ({
  items: [],
  counts: { total: 0, action: 0 },
  filter: 'all',
  loading: false,
  loaded: false,
  loadingMore: false,
  hasMore: false,
  nextCursor: null,

  setFilter: async (filter) => {
    if (filter === get().filter) return
    set({ filter })
    await get().load()
  },

  load: async () => {
    const generation = ++loadGeneration
    const filter = get().filter
    set({ loading: true, loadingMore: false })
    try {
      const page = await api.inboxList({
        severity: severityForFilter(filter),
        limit: PAGE_SIZE,
      })
      if (generation !== loadGeneration) return
      set({
        items: sortByCreated(page.notifications),
        loading: false,
        loaded: true,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor ?? null,
      })
    } catch {
      if (generation === loadGeneration) set({ loading: false })
    }
  },

  loadMore: async () => {
    const state = get()
    if (state.loading || state.loadingMore || !state.hasMore || state.nextCursor == null) return

    const generation = loadGeneration
    const filter = state.filter
    const cursor = state.nextCursor
    set({ loadingMore: true })
    try {
      const page = await api.inboxList({
        severity: severityForFilter(filter),
        cursor,
        limit: PAGE_SIZE,
      })
      if (generation !== loadGeneration) return
      set((current) => ({
        items: appendUnique(current.items, page.notifications),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor ?? null,
      }))
    } catch {
      // Keep hasMore so the user can retry.
    } finally {
      if (generation === loadGeneration) set({ loadingMore: false })
    }
  },

  markRead: async (ids) => {
    if (ids.length === 0) return
    const now = Date.now()
    // Optimistic — counts reconcile from the server's 'counts' echo.
    set((s) => ({
      items: s.items.map((n) => (ids.includes(n.id) && n.readAt == null ? { ...n, readAt: now } : n)),
    }))
    try {
      await api.inboxMarkRead({ ids })
    } catch {
      // The next stream 'counts'/reload will correct any drift.
    }
  },

  markReadBySourceKeys: async (sourceKeys) => {
    const uniqueKeys = [...new Set(sourceKeys.filter(Boolean))]
    if (uniqueKeys.length === 0) return
    const keys = new Set(uniqueKeys)
    const now = Date.now()
    set((s) => ({
      items: s.items.map((n) =>
        keys.has(n.sourceKey) && n.readAt == null ? { ...n, readAt: now } : n,
      ),
    }))
    try {
      await api.inboxMarkRead({ sourceKeys: uniqueKeys })
    } catch {
      // The next stream 'counts'/reload will correct any drift.
    }
  },

  markAllRead: async () => {
    const now = Date.now()
    set((s) => ({ items: s.items.map((n) => (n.readAt == null ? { ...n, readAt: now } : n)) }))
    try {
      await api.inboxMarkRead({ all: true })
    } catch {
      /* reconciled by stream */
    }
  },

  archive: async (id) => {
    const prev = get().items
    set({ items: prev.filter((n) => n.id !== id) })
    try {
      await api.inboxArchive({ ids: [id] })
    } catch {
      set({ items: prev })
    }
  },

  applyEvent: (event) => {
    switch (event.type) {
      case 'counts':
        set({ counts: { total: event.total, action: event.action } })
        break
      case 'notification_upsert':
        set((s) => ({ items: upsert(s.items, event.notification) }))
        break
      case 'notification_read': {
        const now = Date.now()
        const ids = new Set(event.ids)
        set((s) => ({
          items: s.items.map((n) => (ids.has(n.id) && n.readAt == null ? { ...n, readAt: now } : n)),
        }))
        break
      }
      case 'notification_archive': {
        const ids = new Set(event.ids)
        set((s) => ({ items: s.items.filter((n) => !ids.has(n.id)) }))
        break
      }
    }
  },
}))
