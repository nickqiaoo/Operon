import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import type { Activity, ActivitySummary, AssistantAttachment, AssistantBlockerReason, AssistantConfig, AssistantEvent, AssistantMessage, AssistantSchedule, AuditRecord, ProfileFile } from '@shared/assistant'
import { assistantApi, subscribeAssistant } from '@/lib/assistant-api'
import { ApiError } from '@/lib/api-client'
import type { SseSubscription } from '@/lib/sse'
import { resolveLocale, useLocaleStore } from '@/stores/locale-store'
import { useProjectStore } from '@/stores/project-store'

/**
 * A coding agent the assistant started in a workspace the sidebar doesn't have yet (it just
 * created it): the project tree is reloaded once for it, so the workspace shows and its card opens.
 */
const reloadedFor = new Set<number>()
function ensureWorkspaceKnown(activity: ActivitySummary): void {
  const workspaceId = activity.coding?.workspaceId
  if (workspaceId == null || reloadedFor.has(workspaceId)) return
  const { projects, loadProjects } = useProjectStore.getState()
  if (projects.some((p) => p.workspaces.some((w) => w.id === workspaceId))) return
  reloadedFor.add(workspaceId)
  void loadProjects().catch(() => reloadedFor.delete(workspaceId))
}

/** The side panel's lists: each is fetched the first time its tab opens, then kept current by the stream. */
export type AssistantSection = 'activities' | 'audit' | 'schedules'
const SECTIONS: AssistantSection[] = ['activities', 'audit', 'schedules']

interface AssistantStore {
  loaded: boolean
  /** The load itself failed (server unreachable…). */
  error: string | null
  /** Oldest first. */
  messages: AssistantMessage[]
  hasMore: boolean
  loadingOlder: boolean
  /** The reader loaded earlier pages: the list is left whole until they are back at the newest. */
  browsingOlder: boolean
  /**
   * Newest first, without their steps (see {@link useActivity}). Until the Activity tab has been
   * opened, only what the thread needs: the ones at work and the ones its messages point at.
   */
  activities: ActivitySummary[]
  /** Newest first. */
  audit: AuditRecord[]
  /** Standing "Always allow"s, newest first. */
  files: ProfileFile[]
  config: AssistantConfig
  /** Heartbeat first. */
  schedules: AssistantSchedule[]
  sections: Record<AssistantSection, 'idle' | 'loading' | 'loaded'>
  typing: boolean
  /** Why the assistant can't run yet (no model…). */
  blocker: string | null
  blockerReason: AssistantBlockerReason | null

  /** Start loading + live updates. Ref-counted: pair every call with the returned release. */
  open(): () => void
  loadOlder(): Promise<void>
  /** Fetch a panel tab's list, the first time it is asked for. */
  loadSection(section: AssistantSection): Promise<void>
  /** The reader is at the newest message: the list goes back down to its window. */
  settleAtBottom(): void
  send(text: string, attachments?: AssistantAttachment[]): Promise<void>
  stopActivity(id: string): Promise<void>
  decide(approvalId: string, decision: 'allowed_once' | 'denied'): Promise<void>
  followUp(id: string, text: string): Promise<void>
  saveFile(name: ProfileFile['name'], content: string): Promise<void>
  setScheduleEnabled(id: number, enabled: boolean): Promise<void>
  deleteSchedule(id: number): Promise<void>
  runSchedule(id: number): Promise<void>
}

/** Insert or replace by id, keeping `createdAt` order. */
/**
 * Messages kept while the reader is at the newest. The thread never ends — the heartbeat, schedules
 * and coding agents keep adding to it while the app stays open for days — so the list in memory
 * is a window over it: past this many, the oldest are let go (still a "Load earlier" away).
 * The first page the server sends is 200.
 */
export const MESSAGE_WINDOW = 300

export function windowed(messages: AssistantMessage[], browsingOlder: boolean): Pick<AssistantStore, 'messages'> | Pick<AssistantStore, 'messages' | 'hasMore'> {
  if (browsingOlder || messages.length <= MESSAGE_WINDOW) return { messages }
  return { messages: messages.slice(-MESSAGE_WINDOW), hasMore: true }
}

function upsertMessage(list: AssistantMessage[], message: AssistantMessage): AssistantMessage[] {
  const i = list.findIndex((m) => m.id === message.id)
  if (i >= 0) return list.map((m, j) => (j === i ? message : m))
  const next = [...list, message]
  return next[next.length - 2] && next[next.length - 2].createdAt > message.createdAt
    ? next.sort((a, b) => a.createdAt - b.createdAt)
    : next
}

function upsertActivity(list: ActivitySummary[], activity: ActivitySummary): ActivitySummary[] {
  const rest = list.filter((a) => a.id !== activity.id)
  return [activity, ...rest].sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * A fetched list laid over the one in memory, newest first by `time`. `before` is the list in
 * memory when the fetch went out: what the stream changed since is newer than the fetch and wins.
 * What the fetch doesn't have stays (older than its page, or only just added).
 */
export function mergeById<T extends { id: string }>(fetched: T[], current: T[], before: T[], time: (item: T) => number): T[] {
  const untouched = new Set(before)
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of fetched) {
    const mine = byId.get(item.id)
    if (!mine || untouched.has(mine)) byId.set(item.id, item)
  }
  return [...byId.values()].sort((a, b) => time(b) - time(a))
}

let subscription: SseSubscription | null = null
let openCount = 0
let loadGeneration = 0

export const useAssistantStore = create<AssistantStore>((set, get) => {
  const fetchSection = async (section: AssistantSection): Promise<void> => {
    const loaded = (s: AssistantStore) => ({ sections: { ...s.sections, [section]: 'loaded' as const } })
    switch (section) {
      case 'activities': {
        const before = get().activities
        const { activities } = await assistantApi.activities()
        set((s) => ({ activities: mergeById(activities, s.activities, before, (a) => a.startedAt), ...loaded(s) }))
        return
      }
      case 'audit': {
        const before = get().audit
        const { audit } = await assistantApi.audit()
        set((s) => ({ audit: mergeById(audit, s.audit, before, (r) => r.at), ...loaded(s) }))
        return
      }
      case 'schedules': {
        const before = get().schedules
        const { schedules } = await assistantApi.schedules()
        // The stream sends the whole list: one that came in meanwhile is the newer.
        set((s) => ({ schedules: s.schedules === before ? schedules : s.schedules, ...loaded(s) }))
        return
      }
    }
  }

  const load = async () => {
    const generation = ++loadGeneration
    // Lists already shown when this load starts (reopened, back from a dropped stream) may have missed things.
    const stale = SECTIONS.filter((section) => get().sections[section] === 'loaded')
    try {
      const state = await assistantApi.state(resolveLocale(useLocaleStore.getState().localeOverride))
      if (generation !== loadGeneration) return
      set((s) => ({
        loaded: true,
        error: null,
        messages: state.messages,
        hasMore: state.hasMore,
        browsingOlder: false,
        // A list the Activity tab already shows is kept and brought up to date below.
        activities:
          s.sections.activities === 'loaded'
            ? mergeById(state.activities, s.activities, s.activities, (a) => a.startedAt)
            : state.activities,
        files: state.files,
        config: state.config,
        typing: state.typing,
        blocker: state.blocker ?? null,
        blockerReason: state.blockerReason ?? null,
      }))
      // What changed meanwhile is only in the lists themselves.
      for (const section of stale) void fetchSection(section).catch(() => {})
    } catch (error) {
      if (generation !== loadGeneration) return
      set({ loaded: true, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const apply = (event: AssistantEvent) => {
    switch (event.type) {
      case 'message':
        set((s) => windowed(upsertMessage(s.messages, event.message), s.browsingOlder))
        return
      case 'activity':
        set((s) => ({ activities: upsertActivity(s.activities, event.activity) }))
        ensureWorkspaceKnown(event.activity)
        return
      case 'projects':
        void useProjectStore.getState().loadProjects().catch(() => {})
        return
      case 'file':
        set((s) => ({ files: s.files.some((f) => f.name === event.file.name) ? s.files.map((f) => (f.name === event.file.name ? event.file : f)) : [...s.files, event.file] }))
        return
      case 'typing':
        set({ typing: event.typing })
        return
      case 'audit':
        set((s) => ({ audit: [event.record, ...s.audit.filter((r) => r.id !== event.record.id)] }))
        return
      case 'schedules':
        set({ schedules: event.schedules })
        return
      case 'config':
        // A model was picked: whatever blocked the assistant may be gone.
        set({ config: event.config })
        void load()
        return
    }
  }

  return {
    loaded: false,
    error: null,
    messages: [],
    hasMore: false,
    loadingOlder: false,
    browsingOlder: false,
    activities: [],
    audit: [],
    files: [],
    config: { main: { providerId: 'custom', modelId: '' }, worker: { providerId: 'custom', modelId: '' }, background: null, quietStart: '23:00', quietEnd: '08:00' },
    schedules: [],
    sections: { activities: 'idle', audit: 'idle', schedules: 'idle' },
    typing: false,
    blocker: null,
    blockerReason: null,

    open() {
      openCount++
      if (openCount === 1) {
        // Subscribe first so nothing that happens during the load is missed.
        subscription = subscribeAssistant(apply, () => void load())
        void load()
      }
      let released = false
      return () => {
        if (released) return
        released = true
        openCount--
        if (openCount === 0) {
          subscription?.close()
          subscription = null
        }
      }
    },

    async loadOlder() {
      const { messages, hasMore, loadingOlder } = get()
      if (!hasMore || loadingOlder || messages.length === 0) return
      set({ loadingOlder: true, browsingOlder: true })
      try {
        const page = await assistantApi.olderMessages(messages[0].createdAt)
        set((s) => ({
          messages: [...page.messages, ...s.messages],
          hasMore: page.hasMore,
          activities: mergeById(page.activities, s.activities, s.activities, (a) => a.startedAt),
        }))
      } finally {
        set({ loadingOlder: false })
      }
    },

    async loadSection(section) {
      if (get().sections[section] !== 'idle') return
      set((s) => ({ sections: { ...s.sections, [section]: 'loading' } }))
      try {
        await fetchSection(section)
      } catch (error) {
        set((s) => ({ sections: { ...s.sections, [section]: 'idle' } }))
        throw error
      }
    },

    settleAtBottom() {
      const { browsingOlder, messages } = get()
      if (!browsingOlder && messages.length <= MESSAGE_WINDOW) return
      set({ browsingOlder: false, ...windowed(messages, false) })
    },

    async send(text, attachments) {
      // Shown at once, under an id of our own that the server keeps — so its answer and the
      // stream's copy both land on this row instead of adding a second one.
      const id = crypto.randomUUID()
      const pending: AssistantMessage = { id, role: 'user', text, createdAt: Date.now(), ...(attachments?.length ? { attachments } : {}) }
      set((s) => windowed(upsertMessage(s.messages, pending), s.browsingOlder))
      try {
        const { message } = await assistantApi.send(text, attachments, id)
        set((s) => ({ messages: upsertMessage(s.messages, message) }))
      } catch (error) {
        set((s) => ({ messages: s.messages.filter((m) => m.id !== id) }))
        throw error
      }
    },

    async stopActivity(id) {
      await assistantApi.stopActivity(id)
    },

    async decide(approvalId, decision) {
      await assistantApi.decide(approvalId, decision)
    },

    async followUp(id, text) {
      await assistantApi.followUp(id, text)
    },

    async saveFile(name, content) {
      const { file } = await assistantApi.writeFile(name, content)
      apply({ type: 'file', file })
    },

    async setScheduleEnabled(id, enabled) {
      await assistantApi.setScheduleEnabled(id, enabled)
    },

    async deleteSchedule(id) {
      await assistantApi.deleteSchedule(id)
    },

    async runSchedule(id) {
      await assistantApi.runSchedule(id)
    },
  }
})

/** How soon an open activity that is still going fetches its steps again. */
const ACTIVITY_REFRESH_MS = 1000

/**
 * One activity whole, for its detail page: the summary the store keeps current, with the steps and
 * write-up fetched on open — and again (at most once a second) whenever the stream says it moved.
 * `activity` is null until something about it is known; `missing` once the server says it is gone.
 */
export function useActivity(id: string): { activity: Activity | null; loading: boolean; missing: boolean } {
  const summary = useAssistantStore((s) => s.activities.find((a) => a.id === id) ?? null)
  const [detail, setDetail] = useState<Activity | null>(null)
  const [missing, setMissing] = useState(false)
  const lastFetch = useRef(0)
  const currentId = useRef(id)

  useEffect(() => {
    currentId.current = id
    lastFetch.current = 0
    setDetail(null)
    setMissing(false)
  }, [id])

  // Every new summary from the stream is a step further. In-flight fetches are not cancelled when
  // the next one comes: on a busy run that would drop every answer. Stale ones lose to `at`.
  const appliedAt = useRef(0)
  useEffect(() => {
    const fetchNow = () => {
      const at = (lastFetch.current = Date.now())
      assistantApi.activity(id).then(
        ({ activity }) => {
          if (currentId.current !== id || at < appliedAt.current) return
          appliedAt.current = at
          setDetail(activity)
        },
        (error: unknown) => {
          if (currentId.current === id && error instanceof ApiError && error.status === 404) setMissing(true)
        },
      )
    }
    const wait = ACTIVITY_REFRESH_MS - (Date.now() - lastFetch.current)
    if (wait <= 0) {
      fetchNow()
      return
    }
    const timer = setTimeout(fetchNow, wait)
    return () => clearTimeout(timer)
  }, [id, summary])

  const fetched = detail?.id === id ? detail : null
  // The summary is at least as new as the fetch; the steps and write-up only come with the fetch.
  const activity = fetched ? { ...fetched, ...summary } : summary ? { ...summary, steps: [] } : null
  return { activity, loading: !fetched && !missing, missing }
}
