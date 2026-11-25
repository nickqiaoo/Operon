import { delegationMachinesQuery, useMachineStatus } from './delegation-queries'
import { queryClient } from './query-client'
import { useProjectStore, type RemoteProjectTree } from '@/stores/project-store'

/**
 * Whether another machine of the account can be reached right now, from what
 * this machine already knows — no request is made. Two sources, either is
 * enough: Broker lists it offline, or its project tree was asked for and did not
 * load (Broker can list a machine online that does not answer: asleep, a network
 * blip, receiving turned off). Unknown — neither has answered yet — counts as
 * reachable; callers that need to be sure wait for the tree.
 */
export function machineUnreachable(online: boolean | undefined, tree: RemoteProjectTree | undefined): boolean {
  return online === false || (tree?.loaded === true && tree.error != null)
}

/** The account's other machine `nodeId` as the UI shows it: name, and whether it can be reached. */
export function useRemoteMachine(nodeId: string | undefined): { label?: string; online?: boolean; unreachable: boolean } {
  const { label, online } = useMachineStatus(nodeId)
  const tree = useProjectStore((s) => (nodeId ? s.remoteProjects[nodeId] : undefined))
  return { label, online, unreachable: nodeId != null && machineUnreachable(online, tree) }
}

/** `useRemoteMachine` outside React (a click handler). */
export function remoteMachineNow(nodeId: string): { label?: string; online?: boolean; unreachable: boolean } {
  const machine = queryClient.getQueryData(delegationMachinesQuery(undefined).queryKey)?.machines.find((m) => m.nodeId === nodeId)
  const tree = useProjectStore.getState().remoteProjects[nodeId]
  return { label: machine?.label, online: machine?.online, unreachable: machineUnreachable(machine?.online, tree) }
}
