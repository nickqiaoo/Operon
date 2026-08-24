import { Check, Folder } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { cn } from "@/lib/utils"
import { useProjectStore } from "@/stores/project-store"
import { MobileSheet } from "./MobileSheet"

interface MobileContextSwitcherProps {
  open: boolean
  onClose: () => void
}

/**
 * Project → workspace picker. Reuses {@link useProjectStore} (the same data the
 * desktop left sidebar renders) and writes the active context back into it, so
 * every mobile screen scoped by `activeProjectId` / `activeWorkspaceId` follows
 * along. Selecting a workspace also activates its project; selecting a project
 * row activates the project and its first workspace.
 */
export function MobileContextSwitcher({ open, onClose }: MobileContextSwitcherProps) {
  const intl = useIntl()
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeWorkspaceId = useProjectStore((s) => s.activeWorkspaceId)
  const setActiveWorkspace = useProjectStore((s) => s.setActiveWorkspace)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)

  const pickWorkspace = (workspaceId: number, projectId: number) => {
    setActiveWorkspace(workspaceId, projectId)
    onClose()
  }

  const pickProject = (projectId: number, firstWorkspaceId: number | null) => {
    if (firstWorkspaceId != null) {
      setActiveWorkspace(firstWorkspaceId, projectId)
    } else {
      setActiveProject(projectId)
    }
    onClose()
  }

  return (
    <MobileSheet
      open={open}
      onClose={onClose}
      title={intl.formatMessage({ id: "mobile.context.title", defaultMessage: "Switch project" })}
    >
      {projects.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground/70">
          <FormattedMessage id="mobile.context.empty" defaultMessage="No projects yet." />
        </p>
      ) : (
        <div className="space-y-3">
          {projects.map((project) => {
            const projectActive = project.id === activeProjectId
            return (
              <div key={project.id} className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => pickProject(project.id, project.workspaces[0]?.id ?? null)}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-muted/40"
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground/70" />
                  <span
                    className={cn(
                      "truncate text-sm font-medium",
                      projectActive ? "text-foreground" : "text-foreground/80"
                    )}
                  >
                    {project.name}
                  </span>
                </button>
                {project.workspaces.length > 0 && (
                  <div className="ml-4 space-y-0.5 border-l border-border/40 pl-2">
                    {project.workspaces.map((workspace) => {
                      const isActive = workspace.id === activeWorkspaceId
                      return (
                        <button
                          key={workspace.id}
                          type="button"
                          onClick={() => pickWorkspace(workspace.id, project.id)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-muted/40",
                            isActive && "bg-muted/40"
                          )}
                        >
                          <span
                            className={cn(
                              "truncate text-sm",
                              isActive ? "text-foreground" : "text-muted-foreground"
                            )}
                          >
                            {workspace.name}
                          </span>
                          {isActive && <Check className="ml-auto size-4 shrink-0 text-foreground/70" />}
                        </button>
                      )
                    })}
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
