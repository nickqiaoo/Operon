import { create } from 'zustand'
import type { WorkflowRunView } from '@/lib/api'
import type { AgentStreamState } from '@/components/editor/components/agent-stream'

/**
 * The workflow runs this app is WATCHING — not every run that exists.
 *
 * Everything here arrives on the node's workflow feeds, already folded
 * server-side; the client never reconstructs run state from events. It only
 * accumulates sub-agent chunks, through the same reducer the chat UI uses.
 *
 * `runs` — what `/ai/workflow/feed` has reported: in flight when the feed
 * opened, plus anything that started or changed since. A run that finishes while
 * we are connected stays and turns terminal, so a panel showing it updates in
 * place; on reconnect the list resets to whatever is in flight then. Past runs
 * are NOT here — the panel fetches those from `/ai/workflow/runs` when it opens,
 * because a feed held open all session shouldn't carry data only a panel that
 * may never open would read.
 *
 * `streams` — per-run, per-agent accumulated output. Filled from a run's own
 * feed while it is running, and on demand from its recorded chunks once it is
 * not. Nothing here is persisted; the durable copy is the node's event log.
 */
export interface WorkflowRunStream {
  /** Per sub-agent (by index) accumulated stream: text + tool calls, in order. */
  agents: Map<number, AgentStreamState>
  /** The run's feed could not be reached (never started, or pruned). */
  unavailable: boolean
}

interface WorkflowRunsState {
  runs: WorkflowRunView[]
  /**
   * Runs the node reported as STARTING while this app was watching — the signal
   * that raises the workflow panel.
   *
   * It is not derivable from `runs`: a feed opens with a snapshot of recent
   * history, so "a run appeared in the list" is true on every launch for runs
   * that finished days ago. Only a `run` frame carrying `kind: 'started'` means
   * one actually began, so that is what gets recorded here.
   *
   * Keyed `<eventId>:<runId>`, not by run id alone, because a resumed run
   * re-emits `started` under its original id — a fresh key so resuming raises
   * the panel the same way a first attempt does.
   */
  startSignals: Set<string>
  streams: Map<string, WorkflowRunStream>
  /** Replace the whole list — a feed `sync` frame. */
  setRuns: (runs: WorkflowRunView[]) => void
  /** Apply one folded run view — a feed `run` frame. */
  upsertRun: (run: WorkflowRunView) => void
  /** Record a `started` event. `eventId` is the frame's log position. */
  noteRunStarted: (runId: string, eventId: number) => void
  setStream: (runId: string, stream: WorkflowRunStream) => void
  dropStream: (runId: string) => void
}

/** Newest first, matching the node's own ordering (ended, else started). */
function sortRuns(runs: WorkflowRunView[]): WorkflowRunView[] {
  return [...runs].sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
}

export const useWorkflowRunsStore = create<WorkflowRunsState>((set) => ({
  runs: [],
  startSignals: new Set(),
  streams: new Map(),
  setRuns: (runs) => set({ runs: sortRuns(runs) }),
  upsertRun: (run) =>
    set((prev) => {
      const index = prev.runs.findIndex((r) => r.runId === run.runId)
      if (index < 0) return { runs: sortRuns([...prev.runs, run]) }
      const runs = prev.runs.slice()
      runs[index] = run
      return { runs: sortRuns(runs) }
    }),
  noteRunStarted: (runId, eventId) =>
    set((prev) => {
      const key = `${eventId}:${runId}`
      if (prev.startSignals.has(key)) return prev
      return { startSignals: new Set(prev.startSignals).add(key) }
    }),
  setStream: (runId, stream) =>
    set((prev) => {
      const next = new Map(prev.streams)
      next.set(runId, stream)
      return { streams: next }
    }),
  dropStream: (runId) =>
    set((prev) => {
      if (!prev.streams.has(runId)) return prev
      const next = new Map(prev.streams)
      next.delete(runId)
      return { streams: next }
    }),
}))

/** Runs blocking on a human, for one conversation — what the composer bar shows. */
export function selectBlockedRuns(
  state: WorkflowRunsState,
  chatId: number | null | undefined,
): WorkflowRunView[] {
  if (chatId == null) return []
  return state.runs.filter(
    (run) => run.chatId === chatId && (run.pendingApprovals?.length ?? 0) > 0,
  )
}

/** True while any run is still going — drives the tab's spinner and count. */
export function selectRunningCount(state: WorkflowRunsState): number {
  return state.runs.filter((run) => run.status === 'running').length
}
