import { useCallback, useContext, useEffect, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useIntl } from "react-intl"
import { ChevronRight, Folder, FolderOpen, KeyRound, Monitor } from "lucide-react"
import { MachineActionsContext } from "@/components/web/MachineSwitcher"
import { cn } from "@/lib/utils"
import { subscribeEvents } from "@/lib/event-stream"
import { delegationMachinesQuery } from "@/lib/delegation-queries"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { remoteFoldKey, useProjectStore, type Project, type Workspace } from "@/stores/project-store"
import { useChatPresenceStore } from "@/stores/chat-presence-store"
import { chatHistoryKeys } from "@/lib/chat-queries"
import { providersQueryFor } from "@/lib/provider-queries"
import { nodeChatIds } from "@/lib/chat-ref"
import type { DelegationMachine } from "@shared/delegations"

/**
 * The account's other machines, each with its own project tree, under this
 * machine's tree in the sidebar. A workspace belongs to one machine; picking a
 * remote one makes that machine current for the workbench (chats, files, git,
 * terminal). With no other machine on the account, nothing here renders and
 * the sidebar looks as it always did.
 *
 * A remote workspace row is the same row as this machine's (`renderWorkspace`):
 * its latest conversations, the pen for a new chat, folding. A machine shows
 * only once its tree answered: offline or unreachable ones are left out.
 */

/**
 * Other machines of the account this one is paired with (an unpaired one cannot
 * be reached). On web "this one" is the selected machine, so the sidebar is that
 * machine's; the browser then reaches each of the others itself.
 *
 * Always as this machine sees them, also inside another machine's chat (the
 * draft's project picker): asked there, "current" would be that machine and
 * this one would be listed among the others.
 */
export function useOtherMachines(): DelegationMachine[] {
  const { data } = useQuery({ ...delegationMachinesQuery(undefined), refetchInterval: 30_000 })
  return data?.machines.filter((machine) => !machine.current && machine.paired !== false) ?? NO_MACHINES
}

const NO_MACHINES: DelegationMachine[] = []

/**
 * How long to wait before trying a listed machine whose tree did not load
 * again: 30s, 1min, 2min, then every 5min.
 */
export function remoteTreeRetryDelay(attempt: number): number {
  return Math.min(30_000 * 2 ** attempt, 5 * 60_000)
}

/** Space above each machine after the first: the same in every group. */
export const MACHINE_GROUP_GAP = "pt-3"

/** This machine's label, for the header over the local tree once there are others. */
export function useThisMachineLabel(): string | null {
  const { data } = useQuery({ ...delegationMachinesQuery(undefined), refetchInterval: 30_000 })
  return data?.machines.find((machine) => machine.current)?.label ?? null
}

/** A hostname as people say it: `mac-mini.local` → `mac-mini`. */
export function machineDisplayName(label: string): string {
  return label.replace(/\.local\.?$/i, "")
}

/**
 * Header row over one machine's tree. Folding it hides the whole tree. Same
 * height and inset as a project row, in the muted tier: it groups projects, it
 * is not one. Hostnames keep their case (no `heading-section` caps): a long
 * one in capitals was the heaviest thing in the panel.
 */
export function MachineHeader({ label, offline, foldable = true, open, onToggle, trailing }: {
  label: string
  offline?: boolean
  /** False when there is nothing under it to show (offline, unreachable). */
  foldable?: boolean
  open: boolean
  onToggle: () => void
  trailing?: ReactNode
}) {
  return (
    <div className="px-2">
      <button
        type="button"
        onClick={foldable ? onToggle : undefined}
        aria-expanded={foldable ? open : undefined}
        aria-disabled={!foldable || undefined}
        title={label}
        className={cn(
          "group/machine mb-0.5 flex w-full min-w-0 items-center gap-1.5 rounded-lg py-1 pl-2 pr-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-row-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [@media(pointer:coarse)]:py-2",
          !foldable && "cursor-default hover:bg-transparent hover:text-muted-foreground",
          offline && "opacity-60",
        )}
      >
        <Monitor className="size-4 shrink-0" strokeWidth={1.5} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{machineDisplayName(label)}</span>
        {trailing}
        {/* Folded shows always; open only on hover, like the rest of the tree's controls. */}
        {foldable && <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-transform",
            open && "rotate-90 opacity-0 group-hover/machine:opacity-100 group-focus-visible/machine:opacity-100 [@media(hover:none)]:opacity-100",
          )}
          strokeWidth={1.75}
          aria-hidden
        />}
      </button>
    </div>
  )
}

/** One workspace row of another machine, drawn by the sidebar the way it draws its own. */
export type RenderRemoteWorkspace = (nodeId: string, workspace: Workspace, projectId: number, isActive: boolean) => ReactNode

export function RemoteMachineTrees({ machines, activeNodeId, activeWorkspaceId, renderWorkspace }: {
  machines: DelegationMachine[]
  /** The current workspace's machine (null: this one). */
  activeNodeId: string | null
  activeWorkspaceId: number | null
  renderWorkspace: RenderRemoteWorkspace
}) {
  const dropRemoteProjects = useProjectStore((s) => s.dropRemoteProjects)
  // Forget the tree of a machine that left the account.
  const nodeIds = machines.map((machine) => machine.nodeId).join("\n")
  useEffect(() => {
    const listed = new Set(nodeIds.split("\n").filter(Boolean))
    for (const nodeId of Object.keys(useProjectStore.getState().remoteProjects)) {
      if (!listed.has(nodeId)) dropRemoteProjects(nodeId)
    }
  }, [nodeIds, dropRemoteProjects])

  return (
    <>
      {machines.filter((machine) => machine.online).map((machine) => (
        <RemoteMachineTree
          key={machine.nodeId}
          machine={machine}
          activeWorkspaceId={activeNodeId === machine.nodeId ? activeWorkspaceId : null}
          renderWorkspace={renderWorkspace}
        />
      ))}
    </>
  )
}

type ProjectTreeFrame = { type: "ready" } | { type: "tree_changed"; projectId: number }

function RemoteMachineTree({ machine, activeWorkspaceId, renderWorkspace }: {
  machine: DelegationMachine
  activeWorkspaceId: number | null
  renderWorkspace: RenderRemoteWorkspace
}) {
  const intl = useIntl()
  const { nodeId, online } = machine
  const [open, setOpen] = useRemoteFold(remoteFoldKey("machine", nodeId))
  const tree = useProjectStore((s) => s.remoteProjects[nodeId])
  const loadRemoteProjects = useProjectStore((s) => s.loadRemoteProjects)
  const reachable = tree?.loaded === true && tree.error == null
  const failed = tree?.loaded === true && tree.error != null
  const retryable = failed && tree.retryable === true

  // Read the tree when the machine comes online (and again each time it does).
  // Only machines Broker lists as online get here: an offline one is never asked.
  useEffect(() => {
    if (!online) return
    void loadRemoteProjects(nodeId)
  }, [nodeId, online, loadRemoteProjects])

  // A machine Broker lists as online but that did not answer is hidden. When
  // that may pass by itself (asleep, a network blip, Broker timing out), try it
  // again, waiting longer each time. A refusal (no delegation key, receiving
  // turned off, an older version) is not retried on a timer: only when Broker
  // reports it coming online again (above) or the window comes back into focus.
  useEffect(() => {
    if (!online || !retryable) return
    let attempt = 0
    let timer: ReturnType<typeof setTimeout>
    const next = () => {
      timer = setTimeout(() => {
        attempt += 1
        void loadRemoteProjects(nodeId).then(next)
      }, remoteTreeRetryDelay(attempt))
    }
    next()
    return () => clearTimeout(timer)
  }, [nodeId, online, retryable, loadRemoteProjects])

  useEffect(() => {
    if (!online || !failed) return
    const retry = () => void loadRemoteProjects(nodeId)
    window.addEventListener("focus", retry)
    return () => window.removeEventListener("focus", retry)
  }, [nodeId, online, failed, loadRemoteProjects])

  // Then follow it the way this machine's tree follows its own server. Only
  // once it answered: a stream to a machine that can't be reached just retries.
  useEffect(() => {
    if (!online || !reachable) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let seenReady = false
    const schedule = () => {
      if (timer != null) return
      timer = setTimeout(() => {
        timer = null
        void loadRemoteProjects(nodeId)
      }, 150)
    }
    const subscription = subscribeEvents<ProjectTreeFrame>("projects", {
      onEvent: (frame) => {
        if (frame.type === "ready") {
          if (seenReady) schedule()
          seenReady = true
          return
        }
        schedule()
      },
      // The stream dropping is how a machine going away shows up first: read
      // the tree again, and if that fails too the machine is hidden.
      onError: schedule,
    }, nodeId)
    return () => {
      if (timer != null) clearTimeout(timer)
      subscription.close()
    }
  }, [nodeId, online, reachable, loadRemoteProjects])

  const queryClient = useQueryClient()
  // Its agents, read ahead: a new chat there picks one, and asking only then
  // kept the chat from opening for as long as that machine took to answer.
  useEffect(() => {
    if (online && reachable) void queryClient.prefetchQuery(providersQueryFor(nodeId))
  }, [queryClient, nodeId, online, reachable])

  // A turn starting or ending there moves its chat to the top of its workspace's
  // rows, as this machine's do (ActiveConversations). Presence of another machine
  // is followed while one of its chats is open; the lists also poll.
  const runningKey = useChatPresenceStore((s) => [...nodeChatIds(s.runningChats, nodeId)].sort((a, b) => a - b).join(","))
  // It is also when an agent's edits land, so the rows' +N/-N are read again.
  useEffect(() => {
    void queryClient.invalidateQueries({
      predicate: (query) =>
        query.queryKey.at(-1) === nodeId
        && (query.queryKey[0] === chatHistoryKeys.allLists()[0] || (query.queryKey[0] === "git" && query.queryKey[2] === "diff-stat")),
    })
  }, [queryClient, nodeId, runningKey])

  const projects = tree?.projects ?? []
  // Web: this browser has not paired with that machine yet. Unlike a refusal,
  // this one you can fix from here.
  if (online && failed && tree.needsPairing) {
    return <UnpairedMachine machine={machine} onPaired={() => void loadRemoteProjects(nodeId)} />
  }
  // Only a machine that is online and answered: one that is offline, still
  // connecting, turned receiving off or runs an older version would be a row
  // you cannot use. A tree loaded earlier stays cached for when it is back.
  if (!online || !reachable) return null

  return (
    <div data-testid={`machine-tree-${nodeId}`} className={MACHINE_GROUP_GAP}>
      <MachineHeader
        label={machine.label}
        open={open}
        onToggle={() => setOpen(!open)}
      />
      {open && (
        <div>
          {projects.length === 0 && (
            <div className="px-6 py-1 text-xs text-muted-foreground">
              {intl.formatMessage({ id: "sidebar.machine.empty", defaultMessage: "No projects yet." })}
            </div>
          )}
          {projects.map((project) => (
            <RemoteProject
              key={project.id}
              nodeId={nodeId}
              project={project}
              activeWorkspaceId={activeWorkspaceId}
              renderWorkspace={renderWorkspace}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Web: a machine whose tree needs this browser paired with it first. */
function UnpairedMachine({ machine, onPaired }: { machine: DelegationMachine; onPaired: () => void }) {
  const intl = useIntl()
  const actions = useContext(MachineActionsContext)
  if (!actions) return null
  return (
    <div data-testid={`machine-unpaired-${machine.nodeId}`} className={MACHINE_GROUP_GAP}>
      <MachineHeader label={machine.label} foldable={false} open={false} onToggle={() => {}} />
      <div className="px-2">
        <button
          type="button"
          onClick={() => actions.onPairMachine({ nodeId: machine.nodeId, label: machineDisplayName(machine.label), onPaired })}
          className="flex w-full min-w-0 items-center gap-1.5 rounded-lg py-1 pl-2 pr-2 text-left text-xs text-muted-foreground transition-colors hover:bg-row-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [@media(pointer:coarse)]:py-2"
        >
          <KeyRound className="size-4 shrink-0" strokeWidth={1.5} aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {intl.formatMessage({ id: "sidebar.machine.pairBrowser", defaultMessage: "Pair this browser" })}
          </span>
        </button>
      </div>
    </div>
  )
}

const trimSlash = (p: string) => p.replace(/[\\/]+$/, "")

/** Open / set-open for a persisted fold in another machine's tree (open unless folded). */
function useRemoteFold(key: string): [boolean, (open: boolean) => void] {
  const folded = useProjectStore((s) => s.collapsedRemoteKeys.includes(key))
  const setRemoteCollapsed = useProjectStore((s) => s.setRemoteCollapsed)
  const setOpen = useCallback((open: boolean) => setRemoteCollapsed(key, !open), [key, setRemoteCollapsed])
  return [!folded, setOpen]
}

function RemoteProject({ nodeId, project, activeWorkspaceId, renderWorkspace }: {
  nodeId: string
  project: Project
  activeWorkspaceId: number | null
  renderWorkspace: RenderRemoteWorkspace
}) {
  const [open, setOpen] = useRemoteFold(remoteFoldKey("project", nodeId, project.id))
  const ProjectIcon = open ? FolderOpen : Folder
  const containsActive = project.workspaces.some((w) => w.id === activeWorkspaceId)
  const workspaces = [...project.workspaces].sort(
    (a, b) => Number(trimSlash(b.worktreePath) === trimSlash(project.rootPath)) - Number(trimSlash(a.worktreePath) === trimSlash(project.rootPath)),
  )
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="px-2">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          title={project.name}
          aria-label={`${open ? "Collapse" : "Expand"} ${project.name}`}
          className={cn(
            "mb-0.5 flex w-full min-w-0 items-center gap-1.5 rounded-lg py-1 pl-2 text-left text-sm font-medium text-foreground/80 transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [@media(pointer:coarse)]:py-2",
            !open && containsActive && "bg-row-selected text-foreground hover:bg-row-selected",
          )}
        >
          <ProjectIcon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden />
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pb-1">
          {workspaces.map((workspace) => renderWorkspace(nodeId, workspace, project.id, workspace.id === activeWorkspaceId))}
          {workspaces.length === 0 && <div className="px-6 py-1 text-xs text-muted-foreground">No workspaces yet.</div>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
