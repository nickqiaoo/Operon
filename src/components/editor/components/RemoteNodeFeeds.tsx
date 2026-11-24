import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useEditorStore } from '@/stores/editor-store'
import { workspaceBucketKey } from '@/lib/chat-ref'
import { ExternalAgentsSync } from './ExternalAgentsSync'
import { PendingInputSync } from './PendingInputSync'
import { RemoteWorkflowRunsSync } from './WorkflowRunsSync'

/**
 * The live feeds of every other machine whose chat is open in a tab. Renders
 * nothing.
 *
 * This machine's feeds are mounted once by the shell (`PendingInputSync`,
 * `ExternalAgentsSync`, `WorkflowRunsSync`). A remote tab needs the same three
 * from the machine it shows — turn presence and pending input, its external
 * agents, its workflow approvals — and only while it is open. Mounted here, once
 * per machine, rather than per tab: two tabs on one machine must not each own
 * (and on close, clear) that machine's lists.
 */
export function RemoteNodeFeeds() {
  const key = useEditorStore(useShallow((s) => remoteNodeIds(s).join('\n')))
  const nodeIds = useMemo(() => (key ? key.split('\n') : []), [key])
  return (
    <>
      {nodeIds.map((nodeId) => (
        <NodeFeeds key={nodeId} nodeId={nodeId} />
      ))}
    </>
  )
}

function NodeFeeds({ nodeId }: { nodeId: string }) {
  return (
    <>
      <PendingInputSync nodeId={nodeId} />
      <ExternalAgentsSync nodeId={nodeId} />
      <RemoteWorkflowRunsSync nodeId={nodeId} />
    </>
  )
}

/** Machines with a chat open in any workspace's tabs, sorted so the list is stable. */
function remoteNodeIds(state: ReturnType<typeof useEditorStore.getState>): string[] {
  const ids = new Set<string>()
  const currentKey = workspaceBucketKey(state.currentWorkspaceId, state.currentNodeId)
  const buckets = [
    state.tabs,
    ...Object.entries(state.workspaceStates).filter(([key]) => key !== currentKey).map(([, bucket]) => bucket.tabs),
  ]
  for (const tabs of buckets) for (const tab of tabs) if (tab.nodeId) ids.add(tab.nodeId)
  return [...ids].sort()
}
