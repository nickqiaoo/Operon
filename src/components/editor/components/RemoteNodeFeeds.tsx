import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useEditorStore } from '@/stores/editor-store'
import { workspaceBucketKey } from '@/lib/chat-ref'
import { useExternalAgentsStore, type TrackedExternalAgent } from '@/stores/external-agents-store'
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
 *
 * A machine running an external agent this machine's conversations started
 * also gets its pending input watched, tab or not: that is how the parent's
 * Agents card and the sidebar learn the child stopped to ask for approval.
 */
export function RemoteNodeFeeds() {
  const tabKey = useEditorStore(useShallow((s) => remoteNodeIds(s).join('\n')))
  const agentKey = useExternalAgentsStore((s) => activeRemoteAgentNodeIds(s.agents).join('\n'))
  const tabNodeIds = useMemo(() => (tabKey ? tabKey.split('\n') : []), [tabKey])
  const agentOnlyNodeIds = useMemo(() => {
    const withTabs = new Set(tabNodeIds)
    return (agentKey ? agentKey.split('\n') : []).filter((nodeId) => !withTabs.has(nodeId))
  }, [agentKey, tabNodeIds])
  return (
    <>
      {tabNodeIds.map((nodeId) => (
        <NodeFeeds key={nodeId} nodeId={nodeId} />
      ))}
      {agentOnlyNodeIds.map((nodeId) => (
        <PendingInputSync key={`pending:${nodeId}`} nodeId={nodeId} />
      ))}
    </>
  )
}

/**
 * Machines running (or about to run) an external agent this machine started,
 * from this machine's own feed, sorted so the list is stable.
 */
export function activeRemoteAgentNodeIds(agents: ReadonlyMap<string, TrackedExternalAgent>): string[] {
  const ids = new Set<string>()
  for (const agent of agents.values()) {
    if (agent.nodeId || !agent.remote) continue
    if (agent.status === 'running' || agent.status === 'queued') ids.add(agent.remote.nodeId)
  }
  return [...ids].sort()
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
