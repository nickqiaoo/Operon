import { useEffect } from 'react';
import { subscribeSse } from '@/lib/sse';
import { api, type WorkflowFeedFrame } from '@/lib/api';
import { useWorkflowRunsStore } from '@/stores/workflow-runs-store';
import { useWorkflowStream } from '../hooks/useWorkflowStream';

/**
 * Keeps the app's view of workflow runs in sync with the node. Renders nothing.
 *
 * Mounted ONCE, globally. Workflow runs are not a property of the conversation
 * you happen to be looking at — they are launched from one, they report back to
 * one, but they run detached and are displayed in a global panel.
 *
 * Two subscriptions, matching the two layers of the store:
 *  - the global feed, which sends every run's folded view and then each change;
 *  - one feed per RUNNING run for its sub-agents' output. Finished runs get no
 *    subscription: expanding an agent replays its recorded chunks instead.
 */
export function WorkflowRunsSync() {
  const setRuns = useWorkflowRunsStore((s) => s.setRuns);
  const upsertRun = useWorkflowRunsStore((s) => s.upsertRun);
  const noteRunStarted = useWorkflowRunsStore((s) => s.noteRunStarted);
  const runs = useWorkflowRunsStore((s) => s.runs);

  useEffect(() => {
    const subscription = subscribeSse<WorkflowFeedFrame>({
      url: () => api.aiWorkflowFeedUrl(30),
      onEvent: (frame) => {
        if (frame.t === 'sync' && Array.isArray(frame.runs)) setRuns(frame.runs);
        else if (frame.t === 'run') {
          upsertRun(frame.run);
          // The one place a run is known to be BEGINNING rather than merely
          // present. `sync` never gets this treatment — it is the backlog.
          if (frame.kind === 'started') noteRunStarted(frame.run.runId, frame.id);
        }
      },
    });
    return () => subscription.close();
  }, [setRuns, upsertRun, noteRunStarted]);

  const running = runs.filter((run) => run.status === 'running');

  return (
    <>
      {running.map((run) => (
        <RunStreamSubscriber key={run.runId} runId={run.runId} />
      ))}
    </>
  );
}

/** Holds one running run's feed open and lifts its sub-agent output into the store. */
function RunStreamSubscriber({ runId }: { runId: string }) {
  const setStream = useWorkflowRunsStore((s) => s.setStream);
  const dropStream = useWorkflowRunsStore((s) => s.dropStream);
  // The run VIEW from this feed is ignored on purpose: the global feed already
  // delivers it, and taking it from both would mean two writers for one row.
  const { agents, unavailable } = useWorkflowStream(runId);

  useEffect(() => {
    setStream(runId, { agents, unavailable });
  }, [runId, agents, unavailable, setStream]);

  // Drop the accumulated stream when this run stops running: what it produced is
  // in the node's log now, and expanding an agent replays it from there.
  useEffect(() => () => dropStream(runId), [runId, dropStream]);

  return null;
}
