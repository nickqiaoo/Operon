import { useCallback, useState } from 'react'
import { queryOptions, useQuery } from '@tanstack/react-query'
import type { CronjobTask, CronjobUpsertInput } from '@/types/cronjob'
import { toUpsertInput } from '@/components/cronjob/cronjobUtils'
import { api } from './api'
import { queryClient } from './query-client'

/**
 * TanStack Query layer for scheduled tasks. The desktop page and the mobile
 * screen used to each keep their own copy of the list plus an identical set of
 * save / delete / toggle / run handlers; both now read `useCronjobs()` and
 * write through `useCronjobActions()`, which patch the one cached list in place
 * so the UI updates without a refetch.
 */

export const cronjobKeys = {
  all: ['cronjobs'] as const,
  list: () => ['cronjobs', 'list'] as const,
  history: (id: number) => ['cronjobs', 'history', id] as const,
}

type CronjobListResponse = Awaited<ReturnType<typeof api.cronjobList>>

export const cronjobsQuery = queryOptions({
  queryKey: cronjobKeys.list(),
  queryFn: () => api.cronjobList(),
})

const selectCronjobs = (res: CronjobListResponse) => res.cronjobs

/** Every scheduled task, unsorted (callers sort for their own layout). */
export function useCronjobs() {
  return useQuery({ ...cronjobsQuery, select: selectCronjobs })
}

/** Run history of one task. Keyed by id, so switching tasks never shows the previous one's runs. */
export function useCronjobHistory(id: number) {
  return useQuery({
    queryKey: cronjobKeys.history(id),
    queryFn: async () => (await api.cronjobHistory(id)).history,
  })
}

function patchList(update: (jobs: CronjobTask[]) => CronjobTask[]) {
  queryClient.setQueryData<CronjobListResponse>(cronjobKeys.list(), (prev) =>
    prev ? { ...prev, cronjobs: update(prev.cronjobs) } : prev,
  )
}

function replaceJob(job: CronjobTask) {
  patchList((jobs) => jobs.map((item) => (item.id === job.id ? job : item)))
}

/** Writes for scheduled tasks; each one patches the cached list with the server's answer. */
export function useCronjobActions() {
  const [runningIds, setRunningIds] = useState<ReadonlySet<number>>(new Set())

  const create = useCallback(async (input: CronjobUpsertInput) => {
    const { cronjob } = await api.cronjobCreate(input)
    patchList((jobs) => [cronjob, ...jobs])
    return cronjob
  }, [])

  const update = useCallback(async (id: number, input: CronjobUpsertInput) => {
    const { cronjob } = await api.cronjobUpdate(id, input)
    replaceJob(cronjob)
    return cronjob
  }, [])

  const remove = useCallback(async (id: number) => {
    await api.cronjobDelete(id)
    patchList((jobs) => jobs.filter((item) => item.id !== id))
    queryClient.removeQueries({ queryKey: cronjobKeys.history(id) })
  }, [])

  const setEnabled = useCallback(
    (job: CronjobTask, enabled: boolean) => update(job.id, { ...toUpsertInput(job), enabled }),
    [update],
  )

  const run = useCallback(async (job: CronjobTask) => {
    setRunningIds((prev) => new Set(prev).add(job.id))
    try {
      const result = await api.cronjobRun(job.id)
      if (result.cronjob) replaceJob(result.cronjob)
      void queryClient.invalidateQueries({ queryKey: cronjobKeys.history(job.id) })
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev)
        next.delete(job.id)
        return next
      })
    }
  }, [])

  return { create, update, remove, setEnabled, run, runningIds }
}
