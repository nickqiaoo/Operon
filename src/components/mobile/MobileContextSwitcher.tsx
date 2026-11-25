import { Check, Layers, Monitor } from "lucide-react"
import { SpecIcon } from "@/components/icons/SpecIcon"
import { FormattedMessage, useIntl } from "react-intl"
import { cn } from "@/lib/utils"
import { useProjectStore, type Project } from "@/stores/project-store"
import { machineDisplayName } from "@/components/project/RemoteMachineTrees"
import { MobileSheet } from "./MobileSheet"
import { contextProjectGroups } from "./context-projects"
import type { MobileMachineTree } from "./remote-machines"

interface MobileContextSwitcherProps {
  selectedSpecId: number | null
  onSelectSpec: (projectId: number, specId: number) => void
  /** `nodeId`: the workspace is on another machine of the account (absent: this one). */
  onSelectWorkspace: (projectId: number, workspaceId: number | null, nodeId?: string) => void
  /** The account's other machines that answered, each with its project tree. */
  machineTrees: MobileMachineTree[]
  /** This machine's name, shown over its own projects once there are others. */
  thisMachineLabel: string | null
  open: boolean
  onClose: () => void
}

const NO_IDS: readonly number[] = []

/**
 * Selects a project, workspace or Spec context. Conversation rows belong on
 * the Chats page, so opening this picker never loads Spec sessions.
 *
 * With other machines on the account, their projects follow this machine's,
 * each under its machine's name (as in the desktop sidebar). Picking one of
 * their workspaces makes that machine current: the Chats page then lists and
 * starts conversations there. Specs are this machine's only.
 */
export function MobileContextSwitcher({ open, onClose, selectedSpecId, onSelectSpec, onSelectWorkspace, machineTrees, thisMachineLabel }: MobileContextSwitcherProps) {
  const hiddenSpecIds = useProjectStore((s) => s.hiddenSpecIds)
  const shownSpecIds = useProjectStore((s) => s.shownSpecIds)
  const intl = useIntl()
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeWorkspaceId = useProjectStore((s) => s.activeWorkspaceId)
  const activeNodeId = useProjectStore((s) => s.activeNodeId)
  const grouped = machineTrees.length > 0

  const pickWorkspace = (projectId: number, workspaceId: number | null, nodeId?: string) => {
    onSelectWorkspace(projectId, workspaceId, nodeId)
    onClose()
  }

  const renderProject = (project: Project, nodeId?: string) => {
    const here = (nodeId ?? null) === activeNodeId
    const projectActive = here && project.id === activeProjectId
    const groups = nodeId
      ? { workspaces: contextProjectGroups(project, NO_IDS, NO_IDS).workspaces, specs: [] }
      : contextProjectGroups(project, hiddenSpecIds, shownSpecIds)
    return (
      <div key={nodeId ? `${nodeId}:${project.id}` : project.id} className="space-y-0.5">
        <button
          type="button"
          onClick={() => pickWorkspace(project.id, groups.workspaces[0]?.id ?? null, nodeId)}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-row-hover"
        >
          <Layers className="size-4 shrink-0 text-muted-foreground/70" />
          <span
            className={cn(
              "truncate text-base font-medium",
              projectActive ? "text-foreground" : "text-foreground/80"
            )}
          >
            {project.name}
          </span>
        </button>
        {(groups.workspaces.length > 0 || groups.specs.length > 0) && (
          <div className="ml-4 space-y-0.5 border-l border-border/40 pl-2">
            {groups.workspaces.map((workspace) => {
              const isActive = here && selectedSpecId == null && workspace.id === activeWorkspaceId
              return (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => pickWorkspace(project.id, workspace.id, nodeId)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-row-hover",
                    isActive && "bg-row-selected hover:bg-row-selected"
                  )}
                >
                  <span
                    className={cn(
                      "truncate text-base",
                      isActive ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {workspace.name}
                  </span>
                  {isActive && <Check className="ml-auto size-4 shrink-0 text-foreground/70" />}
                </button>
              )
            })}
            {groups.specs.map((spec) => (
              <button
                key={`spec:${spec.id}`}
                type="button"
                aria-pressed={selectedSpecId === spec.id}
                onClick={() => { onSelectSpec(project.id, spec.id); onClose() }}
                className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left hover:bg-row-hover", selectedSpecId === spec.id && "bg-row-selected hover:bg-row-selected")}
              >
                <SpecIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-base">{spec.title}</span>
                {selectedSpecId === spec.id && <Check className="size-4 shrink-0 text-foreground/70" />}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  const empty = (
    <p className="px-3 py-2 text-base text-muted-foreground/70">
      <FormattedMessage id="mobile.context.empty" defaultMessage="No projects yet." />
    </p>
  )

  return (
    <MobileSheet
      open={open}
      onClose={onClose}
      title={intl.formatMessage({ id: "mobile.context.title", defaultMessage: "Switch project" })}
    >
      {!grouped ? (
        projects.length === 0 ? (
          <p className="px-2 py-6 text-center text-base text-muted-foreground/70">
            <FormattedMessage id="mobile.context.empty" defaultMessage="No projects yet." />
          </p>
        ) : (
          <div className="space-y-3">{projects.map((project) => renderProject(project))}</div>
        )
      ) : (
        <div className="space-y-5">
          <section className="space-y-2" data-testid="mobile-context-machine-local">
            <MachineHeading label={thisMachineLabel ?? intl.formatMessage({ id: "mobile.context.thisMachine", defaultMessage: "This machine" })} />
            {projects.length === 0 ? empty : <div className="space-y-3">{projects.map((project) => renderProject(project))}</div>}
          </section>
          {machineTrees.map(({ machine, projects: remote }) => (
            <section key={machine.nodeId} className="space-y-2" data-testid={`mobile-context-machine-${machine.nodeId}`}>
              <MachineHeading label={machine.label} />
              {remote.length === 0 ? empty : <div className="space-y-3">{remote.map((project) => renderProject(project, machine.nodeId))}</div>}
            </section>
          ))}
        </div>
      )}
    </MobileSheet>
  )
}

/** A machine's name over its projects: the muted tier, it groups projects rather than being one. */
function MachineHeading({ label }: { label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground" title={label}>
      <Monitor className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
      <span className="min-w-0 truncate">{machineDisplayName(label)}</span>
    </div>
  )
}
