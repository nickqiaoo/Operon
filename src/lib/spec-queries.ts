import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SpecStage, SpecView } from '@shared/spec'
import { api } from './api'
import { queryClient } from './query-client'

/**
 * TanStack Query layer for specs. One cache entry per spec serves every view
 * of it (the chat card, the bar above the composer, the task page, mobile), and
 * an action taken in one refreshes the rest through `invalidateSpec`.
 */

export const specKeys = {
  all: ['spec'] as const,
  view: (taskId: number) => ['spec', 'view', taskId] as const,
  listByChat: (chatId: number) => ['spec', 'by-chat', chatId] as const,
}

/** Stages in which the server is working and the view changes on its own. */
const LIVE_STAGES: readonly SpecStage[] = ['grounding', 'designing', 'reviewing']
const POLL_MS = 2500
/** Building lasts hours and moves when a ticket does — fast enough to see a review land. */
const BUILD_POLL_MS = 5000
/**
 * Between runs a spec still changes from elsewhere — the chat agent answering its
 * questions, another window resuming it, a ticket editing the signed design — so
 * an idle view checks in now and then instead of never.
 */
const IDLE_POLL_MS = 15_000
/** Between events a spec can still start from elsewhere (another window, the phone). */
const LIST_POLL_MS = 15_000

function pollInterval(spec: SpecView | undefined): number {
  if (spec != null && (spec.running || LIVE_STAGES.includes(spec.run.stage))) return POLL_MS
  if (spec?.run.stage === 'building' || spec?.run.stage === 'integrating') return BUILD_POLL_MS
  return IDLE_POLL_MS
}

/** Refresh every mounted view of a spec after acting on it. */
export function invalidateSpec(taskId: number) {
  return queryClient.invalidateQueries({ queryKey: specKeys.view(taskId) })
}

/**
 * The spec behind a task, kept fresh while its design is running: polls quickly
 * while the design runs and slowly otherwise. `stage` is the task's own
 * `specStage` where the caller has it, so a change made elsewhere (an agent,
 * another device) refetches at once.
 */
export function useSpecView(taskId: number, stage?: SpecStage | null, enabled = true) {
  const query = useQuery({
    queryKey: specKeys.view(taskId),
    queryFn: async () => (await api.specGet(taskId)).spec,
    enabled,
    // A failed read shows its error at once; the next poll is the retry.
    retry: false,
    refetchInterval: (q) => pollInterval(q.state.data),
  })

  const { refetch } = query
  useEffect(() => {
    if (enabled && stage !== undefined) void refetch()
  }, [stage, enabled, refetch])

  const error = query.error ? (query.error instanceof Error ? query.error.message : String(query.error)) : null
  return { spec: query.data ?? null, error }
}

/** The specs a conversation started, newest last. Empty for an unsaved chat. */
export function useChatSpecs(chatId: number | null | undefined) {
  const valid = chatId != null && chatId > 0
  return useQuery({
    queryKey: specKeys.listByChat(chatId ?? 0),
    queryFn: async () => (await api.specListByChat(chatId!)).specs,
    enabled: valid,
    refetchInterval: LIST_POLL_MS,
  })
}

/**
 * A spec card showed up in conversation `chatId`: make its bar pick the spec up
 * now rather than at the next poll. Cards of specs the bar already lists (every
 * card in a reopened transcript) don't trigger a request.
 */
export function noteChatSpecShown(chatId: number, taskId: number) {
  const key = specKeys.listByChat(chatId)
  const listed = queryClient.getQueryData<Array<{ taskId: number }>>(key)
  if (listed?.some((spec) => spec.taskId === taskId)) return
  void queryClient.invalidateQueries({ queryKey: key })
}

export function invalidateChatSpecs() {
  return queryClient.invalidateQueries({ queryKey: ['spec', 'by-chat'] })
}
