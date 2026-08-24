import { useEffect, useMemo, useState } from "react"
import { useIntl } from "react-intl"
import { Workflow as WorkflowIcon } from "lucide-react"
import { api, type WorkflowRunView } from "@/lib/api"
import { useWorkflowRunsStore } from "@/stores/workflow-runs-store"
import { WorkflowRunDetail } from "@/components/editor/components/WorkflowRunDetail"
import type { AgentStreamState } from "@/components/editor/components/agent-stream"

/**
 * The workflow panel tab — recent runs, with each live one's sub-agent work.
 *
 * This lives in a panel tab rather than above the composer for a reason: a run's
 * detail is a sub-agent's full stream (its text and every tool call), which is
 * high-volume and open-ended. Stacked over the input it would push the thing the
 * user is typing into off the screen; here it has real height, scrolls on its
 * own, and can stay open while they keep working.
 *
 * Live runs come from `WorkflowRunsSync` (one global mount, always connected).
 * History is fetched HERE, on open: the feed is held for the whole session so
 * that a run needing a human is noticed, and making it also carry a backlog
 * nobody may look at meant every launch paid to fold runs that had finished days
 * ago. Asking for them when the panel opens is the same data, read when it is
 * actually wanted.
 */

/** A finished run has no live streams; its detail is replayed from the node. */
const NO_STREAMS: Map<number, AgentStreamState> = new Map()

/** Newest first, matching the node's own ordering (ended, else started). */
function byRecency(a: WorkflowRunView, b: WorkflowRunView): number {
  return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)
}

export function WorkflowTab() {
  const intl = useIntl()
  const live = useWorkflowRunsStore((s) => s.runs)
  const streams = useWorkflowRunsStore((s) => s.streams)
  const [history, setHistory] = useState<WorkflowRunView[]>([])

  // Once per open. No polling and no refetch on change: anything that moves is
  // on the feed, and this only supplies the runs that never will.
  useEffect(() => {
    let cancelled = false
    void api
      .aiWorkflowRuns(30)
      .then((page) => {
        if (!cancelled) setHistory(page.runs)
      })
      .catch(() => {
        // Live runs still render; a failed backlog just means a shorter list.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const visible = useMemo(() => {
    // The feed's copy wins: the fetch is a snapshot from open time, and a run
    // that has moved since is in both.
    const byId = new Map(history.map((run) => [run.runId, run]))
    for (const run of live) byId.set(run.runId, run)
    return [...byId.values()].sort(byRecency)
  }, [history, live])

  if (visible.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <WorkflowIcon className="h-5 w-5 text-muted-foreground/40" />
        <div className="text-xs text-muted-foreground">
          {intl.formatMessage({
            id: "workflow.tab.empty",
            defaultMessage: "No workflows yet.",
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="divide-y divide-border/40">
        {visible.map((run) => {
          const stream = streams.get(run.runId)
          return (
            <WorkflowRunDetail
              key={run.runId}
              // One view, from the node's fold. There is no fresher local copy to
              // prefer any more — the global feed re-sends this run on every change.
              run={run}
              fallbackName={run.name}
              agentStreams={stream?.agents ?? NO_STREAMS}
              // With room to breathe, a single run opens expanded; several stay
              // collapsed so the list itself is still scannable.
              defaultOpen={visible.length === 1}
            />
          )
        })}
      </div>
    </div>
  )
}
