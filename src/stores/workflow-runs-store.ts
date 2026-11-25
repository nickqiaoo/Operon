import { create } from 'zustand'
import type { WorkflowRunView } from '@/lib/api'
import { nodeKeyOf, type ChatRef, type NodeKey } from '@/lib/chat-ref'

/**
 * The workflow runs this app is WATCHING — not every run that exists.
 *
 * Everything here arrives on the node's workflow feeds, already folded
 * server-side; the client never reconstructs run state from events.
 *
 * `runs` — what `/ai/workflow/feed` has reported: in flight when the feed
 * opened, plus anything that started or changed since. A run that finishes while
 * we are connected stays and turns terminal, so a panel showing it updates in
 * place; on reconnect the list resets to whatever is in flight then. Past runs
 * are NOT here — the panel fetches those from `/ai/workflow/runs` when it opens,
 * because a feed held open all session shouldn't carry data only a panel that
 * may never open would read.
 */

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
  /**
   * Other machines' runs, by machine — only so a tab showing one of their chats
   * can raise that chat's blocked sub-agents above its composer. Everything
   * above (`runs`, `startSignals`) is this machine's: the workflow
   * panel is a tool of this machine, like the file browser.
   */
  remoteRuns: ReadonlyMap<NodeKey, WorkflowRunView[]>
  /** One remote machine's whole list (its feed's `sync`); `[]` forgets it. */
  setRemoteRuns: (node: NodeKey, runs: WorkflowRunView[]) => void
  upsertRemoteRun: (node: NodeKey, run: WorkflowRunView) => void
  /** Replace the whole list — a feed `sync` frame. */
  setRuns: (runs: WorkflowRunView[]) => void
  /** Apply one folded run view — a feed `run` frame. */
  upsertRun: (run: WorkflowRunView) => void
  /** Record a `started` event. `eventId` is the frame's log position. */
  noteRunStarted: (runId: string, eventId: number) => void
}

/** Newest first, matching the node's own ordering (ended, else started). */
function sortRuns(runs: WorkflowRunView[]): WorkflowRunView[] {
  return [...runs].sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
}

export const useWorkflowRunsStore = create<WorkflowRunsState>((set) => ({
  runs: [],
  startSignals: new Set(),
  remoteRuns: new Map(),
  setRemoteRuns: (node, runs) =>
    set((prev) => {
      const next = new Map(prev.remoteRuns)
      if (runs.length === 0) next.delete(node)
      else next.set(node, runs)
      return { remoteRuns: next }
    }),
  upsertRemoteRun: (node, run) =>
    set((prev) => {
      const current = prev.remoteRuns.get(node) ?? []
      const index = current.findIndex((r) => r.runId === run.runId)
      const runs = index < 0 ? [...current, run] : current.map((r, i) => (i === index ? run : r))
      return { remoteRuns: new Map(prev.remoteRuns).set(node, runs) }
    }),
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
}))

/** Runs blocking on a human, for one conversation — what the composer bar shows. */
export function selectBlockedRuns(
  state: WorkflowRunsState,
  chat: ChatRef | undefined,
): WorkflowRunView[] {
  if (chat == null) return []
  // A run's `chatId` is an id on the machine that reported it.
  const runs = chat.nodeId ? state.remoteRuns.get(nodeKeyOf(chat.nodeId)) ?? [] : state.runs
  return runs.filter(
    (run) => run.chatId === chat.chatId && (run.pendingApprovals?.length ?? 0) > 0,
  )
}

/** True while any run is still going — drives the tab's spinner and count. */
export function selectRunningCount(state: WorkflowRunsState): number {
  return state.runs.filter((run) => run.status === 'running').length
}
