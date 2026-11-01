import { queryOptions, useQuery } from '@tanstack/react-query'
import type { CanvasWorkflowListItem, CanvasWorkflowRun } from '@/types/canvas-workflow'
import { api } from './api'
import { queryClient } from './query-client'

/**
 * TanStack Query layer for canvas workflows: the library list (shared by the
 * canvas page, the sub-workflow picker and the cron editor), each workflow's
 * run history, a live run being polled, and the callers that feed it variables.
 */

export const canvasWorkflowKeys = {
  all: ['canvas-workflows'] as const,
  list: () => ['canvas-workflows', 'list'] as const,
  runs: (workflowId: number) => ['canvas-workflows', 'runs', workflowId] as const,
  run: (runId: number) => ['canvas-workflows', 'run', runId] as const,
  callers: (workflowId: number) => ['canvas-workflows', 'callers', workflowId] as const,
}

type CanvasWorkflowListResponse = Awaited<ReturnType<typeof api.canvasWorkflowList>>

const RUN_POLL_MS = 2_000
const NO_WORKFLOWS: CanvasWorkflowListItem[] = []

/** Every workspace's workflows; the canvas page filters by project itself. */
export const canvasWorkflowsQuery = queryOptions({
  queryKey: canvasWorkflowKeys.list(),
  queryFn: () => api.canvasWorkflowList(),
})

const selectWorkflows = (res: CanvasWorkflowListResponse) => res.workflows

export function useCanvasWorkflows(options?: { enabled?: boolean }) {
  const query = useQuery({ ...canvasWorkflowsQuery, select: selectWorkflows, enabled: options?.enabled })
  return { ...query, workflows: query.data ?? NO_WORKFLOWS }
}

/** Patch the cached library in place after a write, so it updates without a refetch. */
export function patchCanvasWorkflowList(update: (list: CanvasWorkflowListItem[]) => CanvasWorkflowListItem[]) {
  queryClient.setQueryData<CanvasWorkflowListResponse>(canvasWorkflowKeys.list(), (prev) =>
    prev ? { ...prev, workflows: update(prev.workflows) } : prev,
  )
}

/** The editor changes names, node counts and runs: re-list when leaving it. */
export function invalidateCanvasWorkflowList() {
  return queryClient.invalidateQueries({ queryKey: canvasWorkflowKeys.list() })
}

/** The latest 20 runs of one workflow. */
export function useCanvasWorkflowRuns(workflowId: number | undefined) {
  return useQuery({
    queryKey: canvasWorkflowKeys.runs(workflowId ?? 0),
    queryFn: async () => (await api.canvasWorkflowListRuns(workflowId!, 20)).runs,
    enabled: !!workflowId,
  })
}

export const isTerminalRun = (run: CanvasWorkflowRun | undefined) =>
  run?.status === 'success' || run?.status === 'error'

/** A run that was just started, polled every 2s until it finishes (or the poll fails). */
export function useCanvasWorkflowRun(runId: number | null) {
  return useQuery({
    queryKey: canvasWorkflowKeys.run(runId ?? 0),
    queryFn: async () => (await api.canvasWorkflowGetRun(runId!)).run,
    enabled: runId != null,
    // A failed poll ends the watch rather than retrying behind the user's back.
    retry: false,
    refetchInterval: (query) =>
      query.state.status === 'error' || isTerminalRun(query.state.data) ? false : RUN_POLL_MS,
  })
}

export function invalidateCanvasWorkflowRuns(workflowId: number) {
  return queryClient.invalidateQueries({ queryKey: canvasWorkflowKeys.runs(workflowId) })
}

/** Other workflows that call this one through a Sub-workflow node, with the keys each hands over. */
export function useCanvasWorkflowCallers(workflowId: number | undefined) {
  return useQuery({
    queryKey: canvasWorkflowKeys.callers(workflowId ?? 0),
    queryFn: async () => (await api.canvasWorkflowCallers(workflowId!)).callers,
    enabled: !!workflowId,
  })
}
