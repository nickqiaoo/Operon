import { useEffect } from 'react';
import { subscribeEvents } from '@/lib/event-stream';
import type { WorkflowFeedFrame } from '@/lib/api';
import { useWorkflowRunsStore } from '@/stores/workflow-runs-store';
import { nodeKeyOf } from '@/lib/chat-ref';

/**
 * Keeps the app's view of workflow runs in sync with the node. Renders nothing.
 *
 * Mounted ONCE, globally. Workflow runs are not a property of the conversation
 * you happen to be looking at — they are launched from one, they report back to
 * one, but they run detached and are displayed in a global panel.
 *
 * One subscription: the global feed, which sends every run's folded view and
 * then each change. A sub-agent's output is not kept here — an expanded agent
 * reads its chat and watches that chat's turn stream (useWorkflowAgentTranscript).
 */
export function WorkflowRunsSync() {
  const setRuns = useWorkflowRunsStore((s) => s.setRuns);
  const upsertRun = useWorkflowRunsStore((s) => s.upsertRun);
  const noteRunStarted = useWorkflowRunsStore((s) => s.noteRunStarted);

  useEffect(() => {
    const subscription = subscribeEvents<WorkflowFeedFrame>('workflow', {
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

  return null;
}

/**
 * Another machine's run list, for the approval bar of tabs showing its chats
 * (see `RemoteNodeFeeds`). No start signals: those raise the workflow panel,
 * which shows this machine's runs.
 */
export function RemoteWorkflowRunsSync({ nodeId }: { nodeId: string }) {
  useEffect(() => {
    const node = nodeKeyOf(nodeId);
    const store = useWorkflowRunsStore.getState();
    const subscription = subscribeEvents<WorkflowFeedFrame>('workflow', {
      onEvent: (frame) => {
        if (frame.t === 'sync' && Array.isArray(frame.runs)) store.setRemoteRuns(node, frame.runs);
        else if (frame.t === 'run') store.upsertRemoteRun(node, frame.run);
      },
    }, nodeId);
    return () => {
      subscription.close();
      store.setRemoteRuns(node, []);
    };
  }, [nodeId]);
  return null;
}
