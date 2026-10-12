import type {
  AssistantAttachment,
  AssistantConfig,
  AssistantEvent,
  AssistantMessage,
  AssistantState,
  ProfileFile,
  ProfileFileName,
} from '@shared/assistant'
import { getBaseUrl, request } from './api-client.js'
import { subscribeSse, type SseSubscription } from './sse.js'

/** Client for `/api/assistant` (server/src/routes/assistant.ts). */
export const assistantApi = {
  /** `locale` is the UI language, so the assistant's first words match it. */
  state: (locale?: string) => request<AssistantState>(`/assistant/state${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`),
  olderMessages: (before: number) =>
    request<{ messages: AssistantMessage[]; hasMore: boolean }>(`/assistant/messages?before=${before}`),
  /** `id`: the client's own id for the message, which the server keeps. */
  send: (text: string, attachments: AssistantAttachment[] = [], id?: string) =>
    request<{ message: AssistantMessage }>('/assistant/messages', { method: 'POST', body: JSON.stringify({ text, attachments, id }) }),
  stopActivity: (id: string) =>
    request<{ stopped: boolean }>(`/assistant/activities/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  followUp: (id: string, text: string) =>
    request<{ result: 'delivered' | 'continued' }>(`/assistant/activities/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  decide: (approvalId: string, decision: 'allowed_once' | 'denied') =>
    request<{ ok: boolean }>(`/assistant/approvals/${encodeURIComponent(approvalId)}`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),
  writeFile: (name: ProfileFileName, content: string) =>
    request<{ file: ProfileFile }>(`/assistant/files/${name}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  setScheduleEnabled: (id: number, enabled: boolean) =>
    request<{ ok: boolean }>(`/assistant/schedules/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteSchedule: (id: number) => request<{ ok: boolean }>(`/assistant/schedules/${id}`, { method: 'DELETE' }),
  runSchedule: (id: number) => request<{ started: number }>(`/assistant/schedules/${id}/run`, { method: 'POST' }),
  clearHeartbeatLimit: (service: string) =>
    request<{ ok: boolean }>(`/assistant/heartbeat/limits/${encodeURIComponent(service)}`, { method: 'DELETE' }),
  getConfig: () => request<AssistantConfig>('/assistant/config'),
  setConfig: (patch: Partial<AssistantConfig>) =>
    request<AssistantConfig>('/assistant/config', { method: 'PUT', body: JSON.stringify(patch) }),
}

/** Live assistant updates. Reconnects on its own; close it when the view goes away. */
export function subscribeAssistant(onEvent: (event: AssistantEvent) => void, onReconnect: () => void): SseSubscription {
  let connectedOnce = false
  return subscribeSse<AssistantEvent>({
    url: async () => {
      // Anything that happened while the stream was down is only in /state: refetch on reconnect.
      if (connectedOnce) onReconnect()
      connectedOnce = true
      return `${await getBaseUrl()}/assistant/stream`
    },
    onEvent,
    onParseError: (e) => console.warn('[assistant] bad stream frame:', e),
    onError: (e) => console.warn('[assistant] stream dropped:', e),
  })
}
