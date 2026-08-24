import { api } from "@/lib/api"
import { ChevronDown, Trash2, RefreshCcw } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { Button } from "@/components/ui/button"
import { useProjectStore } from "@/stores/project-store"
import { useState } from "react"

interface RepoDetailProps {
    projectId: number
    onBack: () => void
}

export function RepoDetail({ projectId, onBack }: RepoDetailProps) {
    const intl = useIntl()
    const projects = useProjectStore((s) => s.projects)
    const removeProject = useProjectStore((s) => s.removeProject)
    const removeWorkspace = useProjectStore((s) => s.removeWorkspace)
    const project = projects.find(p => p.id === projectId)
    const [confirmDeleteProject, setConfirmDeleteProject] = useState(false)
    const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<number | null>(null)

    if (!project) return <div><FormattedMessage id="settings.repo.notFound" defaultMessage="Project not found" /></div>

    const handleDeleteProject = async () => {
        await removeProject(project.id)
        onBack()
    }

    const handleDeleteWorkspace = async (workspaceId: number, worktreePath: string) => {
        if (!window.confirm(intl.formatMessage({ id: "settings.repo.deleteWorkspaceConfirm", defaultMessage: "Delete this workspace? This will remove the worktree from disk." }))) return
        if (!window.confirm(intl.formatMessage({ id: "settings.repo.forceDeleteWorkspaceConfirm", defaultMessage: "Force delete this workspace?\n\nThis will discard modified and untracked files in:\n{path}" }, { path: worktreePath }))) return

        setDeletingWorkspaceId(workspaceId)
        try {
            await api.gitWorktreeRemove(project.rootPath, worktreePath, { force: true })
            await removeWorkspace(project.id, workspaceId)
        } catch (error) {
            console.error("Failed to remove worktree:", error)
            const message = error instanceof Error ? error.message : intl.formatMessage({ id: "common.unknownError", defaultMessage: "Unknown error" })
            alert(intl.formatMessage({ id: "settings.repo.deleteWorkspaceFailed", defaultMessage: "Failed to delete workspace:\n{message}" }, { message }))
        } finally {
            setDeletingWorkspaceId(null)
        }
    }

    const getParentPath = (filePath: string) => {
        const normalized = filePath.replace(/[\\/]+$/, "")
        const separator = normalized.includes("\\") ? "\\" : "/"
        const index = normalized.lastIndexOf(separator)
        return index > 0 ? normalized.slice(0, index) : normalized
    }

    return (
        <div className="space-y-10 pb-20">
            {/* Info Section */}
            <div className="space-y-6">
                <div>
                    <div className="text-sm font-medium mb-1.5"><FormattedMessage id="settings.repo.rootPath" defaultMessage="Root path" /></div>
                    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted/30 border border-border/60 text-xs font-mono text-muted-foreground">
                        {project.rootPath}
                        <ChevronDown className="h-3 w-3 ml-auto opacity-50" />
                    </div>
                </div>

                <div>
                    <div className="text-sm font-medium mb-1.5"><FormattedMessage id="settings.repo.workspacesPath" defaultMessage="Workspaces path" /></div>
                    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted/30 border border-border/60 text-xs font-mono text-muted-foreground">
                        {getParentPath(project.rootPath)}
                        <ChevronDown className="h-3 w-3 ml-auto opacity-50" />
                    </div>
                </div>
            </div>

            <div className="h-px bg-border/50" />

            {/* Configuration Section */}
            <div className="space-y-6">
                <div>
                    <div className="text-sm font-medium mb-1.5"><FormattedMessage id="settings.repo.branchFrom" defaultMessage="Branch new workspaces from" /></div>
                    <div className="text-xs text-muted-foreground mb-3"><FormattedMessage id="settings.repo.branchFromDesc" defaultMessage="Each workspace is an isolated copy of your codebase." /></div>
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-border/60 bg-background text-sm">
                        <span>origin/dev</span>
                        <ChevronDown className="h-3 w-3 opacity-50" />
                    </div>
                </div>

                <div>
                    <div className="text-sm font-medium mb-1.5"><FormattedMessage id="settings.repo.remoteOrigin" defaultMessage="Remote origin" /></div>
                    <div className="text-xs text-muted-foreground mb-3"><FormattedMessage id="settings.repo.remoteOriginDesc" defaultMessage="Where should we push, pull, and create PRs?" /></div>
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-border/60 bg-background text-sm">
                        <span>origin</span>
                        <ChevronDown className="h-3 w-3 opacity-50" />
                    </div>
                </div>
            </div>

            <div className="h-px bg-border/50" />

            {/* Workspaces Management */}
            <div>
                <h2 className="text-lg font-semibold mb-2"><FormattedMessage id="settings.repo.workspaces" defaultMessage="Workspaces" /></h2>
                <div className="text-sm text-muted-foreground mb-6"><FormattedMessage id="settings.repo.workspacesDesc" defaultMessage="Manage your active workspaces." /></div>

                <div className="space-y-2">
                    {project.workspaces.length === 0 ? (
                        <div className="text-sm text-muted-foreground italic"><FormattedMessage id="settings.repo.noWorkspaces" defaultMessage="No active workspaces." /></div>
                    ) : (
                        project.workspaces.map(workspace => (
                            <div key={workspace.id} className="flex items-center justify-between p-3 rounded-lg border border-border/60 bg-background">
                                <div>
                                    <div className="text-sm font-medium">{workspace.name}</div>
                                    <div className="text-xs text-muted-foreground font-mono mt-0.5">{workspace.branchName}</div>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                    onClick={() => handleDeleteWorkspace(workspace.id, workspace.worktreePath)}
                                    disabled={deletingWorkspaceId === workspace.id}
                                    title={intl.formatMessage({ id: "settings.repo.deleteWorkspaceTitle", defaultMessage: "Delete workspace" })}
                                >
                                    {deletingWorkspaceId === workspace.id ? (
                                        <RefreshCcw className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Trash2 className="h-4 w-4" />
                                    )}
                                </Button>
                            </div>
                        ))
                    )}
                </div>
            </div>

            <div className="h-px bg-border/50" />

            {/* Remove Repository */}
            <div>
                {!confirmDeleteProject ? (
                    <Button
                        variant="ghost"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setConfirmDeleteProject(true)}
                    >
                        <Trash2 className="h-4 w-4 mr-2" />
                        <FormattedMessage id="settings.repo.removeRepo" defaultMessage="Remove repository" />
                    </Button>
                ) : (
                    <div className="flex items-center gap-2 animate-in fade-in slide-in-from-left-2 duration-200">
                        <div className="text-sm text-destructive font-medium mr-2"><FormattedMessage id="settings.repo.areYouSure" defaultMessage="Are you sure?" /></div>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => void handleDeleteProject()}
                        >
                            <FormattedMessage id="settings.repo.yesRemove" defaultMessage="Yes, remove" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmDeleteProject(false)}
                        >
                            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
                        </Button>
                    </div>
                )}
            </div>
        </div>
    )
}
