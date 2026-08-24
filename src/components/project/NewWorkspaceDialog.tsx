import { Button } from "@/components/ui/button"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useState, useEffect } from "react"
import { useIntl, FormattedMessage } from "react-intl"
import { toast } from "sonner"
import { Project } from "@/stores/project-store"
import { GitBranch, Loader2 } from "lucide-react"

interface NewWorkspaceDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    project: Project | null
    onConfirm: (branchName: string) => Promise<void>
}

export function NewWorkspaceDialog({ open, onOpenChange, project, onConfirm }: NewWorkspaceDialogProps) {
    const intl = useIntl()
    const [branchName, setBranchName] = useState("")
    const [isCreating, setIsCreating] = useState(false)

    // Reset state when dialog opens
    useEffect(() => {
        if (open) {
            setBranchName("")
            setIsCreating(false)
        }
    }, [open])

    const getWorktreePath = () => {
        if (!project || !branchName) return "..."

        const safeBranch = branchName.replace(/[^a-zA-Z0-9._-]+/g, "-")
        // Mirror the server's managed layout: ~/.operon/worktrees/<id>-<repo>/<name>
        // (worktreePathFor uses the repo dir basename, not the display name).
        const repo = project.rootPath.replace(/[\\/]+$/, "").split(/[/\\]/).pop()
        return `~/.operon/worktrees/${project.id}-${repo}/${safeBranch}`
    }

    const handleConfirm = async () => {
        if (!branchName.trim()) return

        setIsCreating(true)
        try {
            await onConfirm(branchName)
            setIsCreating(false)
            onOpenChange(false)
        } catch (error) {
            console.error("Failed to create workspace:", error)
            setIsCreating(false)
            toast.error(intl.formatMessage({ id: "workspace.new.error", defaultMessage: "Failed to create workspace" }), {
                description: error instanceof Error ? error.message : String(error),
            })
        }
    }

    return (
        <Dialog open={open} onOpenChange={(val) => !isCreating && onOpenChange(val)}>
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle><FormattedMessage id="workspace.new.title" defaultMessage="New Workspace" /></DialogTitle>
                    <DialogDescription>
                        <FormattedMessage id="workspace.new.desc" defaultMessage="Create a new isolated workspace for your changes." />
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-3">
                    <div className="grid gap-2">
                        <label htmlFor="branch" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                            <FormattedMessage id="workspace.new.branchName" defaultMessage="Branch Name" />
                        </label>
                        <div className="relative">
                            <GitBranch className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                                id="branch"
                                value={branchName}
                                onChange={(e) => setBranchName(e.target.value)}
                                placeholder="feature/new-feature"
                                className="pl-9"
                                autoFocus
                                disabled={isCreating}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && branchName) {
                                        handleConfirm()
                                    }
                                }}
                            />
                        </div>
                    </div>
                    <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                        <span className="font-medium"><FormattedMessage id="workspace.new.worktreePath" defaultMessage="Worktree Path:" /></span> {getWorktreePath()}
                        <br />
                        <span className="opacity-70"><FormattedMessage id="workspace.new.worktreeHint" defaultMessage="Created under operon's managed worktrees folder (~/.operon/worktrees), not next to your project." /></span>
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isCreating}>
                        <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
                    </Button>
                    <Button variant="secondary" onClick={handleConfirm} disabled={!branchName.trim() || isCreating}>
                        {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        <FormattedMessage id="workspace.new.create" defaultMessage="Create Workspace" />
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
