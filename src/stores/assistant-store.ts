import { create } from 'zustand'
import type { Activity, AssistantAttachment, AssistantConfig, AssistantEvent, AssistantMessage, AssistantSchedule, AuditRecord, ProfileFile } from '@shared/assistant'
import { assistantApi, subscribeAssistant } from '@/lib/assistant-api'
import type { SseSubscription } from '@/lib/sse'
import { resolveLocale, useLocaleStore } from '@/stores/locale-store'

interface AssistantStore {
  loaded: boolean
  /** The load itself failed (server unreachable…). */
  error: string | null
  /** Oldest first. */
  messages: AssistantMessage[]
  hasMore: boolean
  loadingOlder: boolean
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

  /** Start loading + live updates. Ref-counted: pair every call with the returned release. */
  open(): () => void
  loadOlder(): Promise<void>
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
        activities: state.activities,
        audit: state.audit,
        files: state.files,
        config: state.config,
        schedules: state.schedules,
        typing: state.typing,
        blocker: state.blocker ?? null,
      })
    } catch (error) {
      if (generation !== loadGeneration) return
      set({ loaded: true, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const apply = (event: AssistantEvent) => {
    switch (event.type) {
      case 'message':
        set((s) => ({ messages: upsertMessage(s.messages, event.message) }))
        return
      case 'activity':
        set((s) => ({ activities: upsertActivity(s.activities, event.activity) }))
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
    activities: [],
    audit: [],
    files: [],
    config: { main: { providerId: 'custom', modelId: '' }, worker: { providerId: 'custom', modelId: '' }, background: null, quietStart: '23:00', quietEnd: '08:00' },
    schedules: [],
    typing: false,
    blocker: null,

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
      set({ loadingOlder: true })
      try {
        const page = await assistantApi.olderMessages(messages[0].createdAt)
        set((s) => ({ messages: [...page.messages, ...s.messages], hasMore: page.hasMore }))
      } finally {
        set({ loadingOlder: false })
      }
    },

    async send(text, attachments) {
      const { message } = await assistantApi.send(text, attachments)
      set((s) => ({ messages: upsertMessage(s.messages, message) }))
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
