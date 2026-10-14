import { create } from 'zustand'
import type { Activity, AssistantAttachment, AssistantBlockerReason, AssistantConfig, AssistantEvent, AssistantMessage, AssistantSchedule, AuditRecord, ProfileFile } from '@shared/assistant'
import { assistantApi, subscribeAssistant } from '@/lib/assistant-api'
import type { SseSubscription } from '@/lib/sse'
import { resolveLocale, useLocaleStore } from '@/stores/locale-store'
import { useProjectStore } from '@/stores/project-store'

/**
 * A coding agent the assistant started in a workspace the sidebar doesn't have yet (it just
 * created it): the project tree is reloaded once for it, so the workspace shows and its card opens.
 */
const reloadedFor = new Set<number>()
function ensureWorkspaceKnown(activity: Activity): void {
  const workspaceId = activity.coding?.workspaceId
  if (workspaceId == null || reloadedFor.has(workspaceId)) return
  const { projects, loadProjects } = useProjectStore.getState()
  if (projects.some((p) => p.workspaces.some((w) => w.id === workspaceId))) return
  reloadedFor.add(workspaceId)
  void loadProjects().catch(() => reloadedFor.delete(workspaceId))
}

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
  /** Newest first. */
  activities: Activity[]
  /** Newest first. */
  audit: AuditRecord[]
  /** Standing "Always allow"s, newest first. */
  files: ProfileFile[]
  config: AssistantConfig
  /** Heartbeat first. */
  schedules: AssistantSchedule[]
  typing: boolean
  /** Why the assistant can't run yet (no model…). */
  blocker: string | null
  blockerReason: AssistantBlockerReason | null

  /** Start loading + live updates. Ref-counted: pair every call with the returned release. */
  open(): () => void
  loadOlder(): Promise<void>
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

function upsertActivity(list: Activity[], activity: Activity): Activity[] {
  const rest = list.filter((a) => a.id !== activity.id)
  return [activity, ...rest].sort((a, b) => b.startedAt - a.startedAt)
}

let subscription: SseSubscription | null = null
let openCount = 0
let loadGeneration = 0

export const useAssistantStore = create<AssistantStore>((set, get) => {
  const load = async () => {
    const generation = ++loadGeneration
    try {
      const state = await assistantApi.state(resolveLocale(useLocaleStore.getState().localeOverride))
      if (generation !== loadGeneration) return
      set({
        loaded: true,
        error: null,
        messages: state.messages,
        hasMore: state.hasMore,
        browsingOlder: false,
        activities: state.activities,
        audit: state.audit,
        files: state.files,
        config: state.config,
        schedules: state.schedules,
        typing: state.typing,
        blocker: state.blocker ?? null,
        blockerReason: state.blockerReason ?? null,
      })
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
        set((s) => ({ messages: [...page.messages, ...s.messages], hasMore: page.hasMore }))
      } finally {
        set({ loadingOlder: false })
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
