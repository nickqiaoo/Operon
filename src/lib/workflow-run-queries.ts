import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { queryClient } from './query-client'

/**
 * TanStack Query layer for a workflow run's detail panel: the script it was
 * launched with, and one agent's recorded transcript (replayed when no live
 * stream is attached).
 */
export const workflowRunKeys = {
  all: ['workflow-run'] as const,
  script: (runId: string) => ['workflow-run', runId, 'script'] as const,
  agentChunks: (runId: string, agentIndex: number) => ['workflow-run', runId, 'agent', agentIndex, 'chunks'] as const,
}

/** A run's script never changes once launched: fetched once, on first open. */
export function useWorkflowRunScript(runId: string, { enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: workflowRunKeys.script(runId),
    queryFn: async () => (await api.aiWorkflowScript(runId)).script ?? '',
    enabled,
    staleTime: Infinity,
    retry: false,
  })
}

const AGENT_POLL_MS = 3000

/**
 * An agent's recorded chunks. While the agent is still running (and no live
 * stream is attached) it is re-read every few seconds so the row keeps up.
 */
export function useWorkflowAgentChunks(
  runId: string | undefined,
  agentIndex: number,
  { enabled, running }: { enabled: boolean; running: boolean },
) {
  return useQuery({
    queryKey: workflowRunKeys.agentChunks(runId ?? '', agentIndex),
    queryFn: () => api.aiWorkflowAgentChunks(runId!, agentIndex),
    enabled: enabled && runId != null,
    refetchInterval: running ? AGENT_POLL_MS : false,
    refetchIntervalInBackground: false,
    retry: false,
  })
}

/** Re-read an agent's transcript now — e.g. right after a message was sent to it. */
export function invalidateWorkflowAgentChunks(runId: string, agentIndex: number) {
  return queryClient.invalidateQueries({ queryKey: workflowRunKeys.agentChunks(runId, agentIndex) })
}
