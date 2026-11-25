import { useCallback, useEffect, useMemo } from "react"
import { useOtherMachines } from "@/components/project/RemoteMachineTrees"
import { useProjectStore, type Project } from "@/stores/project-store"
import type { DelegationMachine } from "@shared/delegations"

export interface MobileMachineTree {
  machine: DelegationMachine
  projects: Project[]
}

const NO_TREES: MobileMachineTree[] = []

/**
 * The account's other machines whose project trees answered, for the context
 * picker. The phone's version of the sidebar's `RemoteMachineTrees`: no
 * stream per machine and no retry timer, the trees are read when a machine
 * comes online and again each time the picker opens (`refresh`). A machine
 * that is offline or did not answer is left out, as in the sidebar.
 */
export function useMobileMachineTrees(): { trees: MobileMachineTree[]; refresh: () => void } {
  const machines = useOtherMachines()
  const remoteProjects = useProjectStore((s) => s.remoteProjects)
  const loadRemoteProjects = useProjectStore((s) => s.loadRemoteProjects)
  const dropRemoteProjects = useProjectStore((s) => s.dropRemoteProjects)

  const online = useMemo(() => machines.filter((machine) => machine.online), [machines])
  const onlineKey = online.map((machine) => machine.nodeId).join("\n")

  const refresh = useCallback(() => {
    for (const nodeId of onlineKey.split("\n").filter(Boolean)) void loadRemoteProjects(nodeId)
  }, [onlineKey, loadRemoteProjects])

  // Read each tree when its machine comes online (and again each time it does).
  useEffect(refresh, [refresh])

  // Forget the tree of a machine that left the account.
  const listedKey = machines.map((machine) => machine.nodeId).join("\n")
  useEffect(() => {
    const listed = new Set(listedKey.split("\n").filter(Boolean))
    for (const nodeId of Object.keys(useProjectStore.getState().remoteProjects)) {
      if (!listed.has(nodeId)) dropRemoteProjects(nodeId)
    }
  }, [listedKey, dropRemoteProjects])

  const trees = useMemo(() => {
    const reachable = online.flatMap((machine) => {
      const tree = remoteProjects[machine.nodeId]
      return tree?.loaded === true && tree.error == null ? [{ machine, projects: tree.projects }] : []
    })
    return reachable.length > 0 ? reachable : NO_TREES
  }, [online, remoteProjects])

  return { trees, refresh }
}
