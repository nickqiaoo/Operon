import { Check, Layers } from "lucide-react"
import { SpecIcon } from "@/components/icons/SpecIcon"
import { FormattedMessage, useIntl } from "react-intl"
import { cn } from "@/lib/utils"
import { useProjectStore } from "@/stores/project-store"
import { MobileSheet } from "./MobileSheet"
import { contextProjectGroups } from "./context-projects"

interface MobileContextSwitcherProps {
  selectedSpecId: number | null
  onSelectSpec: (projectId: number, specId: number) => void
  onSelectWorkspace: (projectId: number, workspaceId: number | null) => void
  open: boolean
  onClose: () => void
}

/**
 * Selects a project, workspace or Spec context. Conversation rows belong on
 * the Chats page, so opening this picker never loads Spec sessions.
 */
export function MobileContextSwitcher({ open, onClose, selectedSpecId, onSelectSpec, onSelectWorkspace }: MobileContextSwitcherProps) {
  const hiddenSpecIds = useProjectStore((s) => s.hiddenSpecIds)
  const shownSpecIds = useProjectStore((s) => s.shownSpecIds)
  const intl = useIntl()
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeWorkspaceId = useProjectStore((s) => s.activeWorkspaceId)

  const pickWorkspace = (workspaceId: number | null, projectId: number) => {
    onSelectWorkspace(projectId, workspaceId)
    onClose()
  }

  return (
    <MobileSheet
      open={open}
      onClose={onClose}
      title={intl.formatMessage({ id: "mobile.context.title", defaultMessage: "Switch project" })}
    >
      {projects.length === 0 ? (
        <p className="px-2 py-6 text-center text-base text-muted-foreground/70">
          <FormattedMessage id="mobile.context.empty" defaultMessage="No projects yet." />
        </p>
      ) : (
        <div className="space-y-3">
          {projects.map((project) => {
            const projectActive = project.id === activeProjectId
            const groups = contextProjectGroups(project, hiddenSpecIds, shownSpecIds)
            return (
              <div key={project.id} className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => pickWorkspace(groups.workspaces[0]?.id ?? null, project.id)}
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
                      const isActive = selectedSpecId == null && workspace.id === activeWorkspaceId
                      return (
                        <button
                          key={workspace.id}
                          type="button"
                          onClick={() => pickWorkspace(workspace.id, project.id)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-row-hover",
                            isActive && "bg-muted/40"
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
                        className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left hover:bg-row-hover", selectedSpecId === spec.id && "bg-muted/40")}
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
          })}
        </div>
      )}
    </MobileSheet>
  )
}
