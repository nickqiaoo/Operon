import { useMemo, useRef, useState } from "react"
import { ArrowLeft, FolderTree, RefreshCw } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { useProjectStore } from "@/stores/project-store"
import { FilePreviewPane } from "@/components/workspace-browser/FilePreviewPane"
import {
  WorkspaceFileTree,
  type WorkspaceFileTreeHandle,
} from "@/components/workspace-browser/WorkspaceFileTree"

interface MobileFilesScreenProps {
  onBack: () => void
}

/**
 * Read-only workspace file browser on mobile — the phone form of the desktop
 * {@link WorkspaceBrowserTab}. Reuses the exact same {@link WorkspaceFileTree}
 * and {@link FilePreviewPane}, just as a two-level push (tree → preview) instead
 * of the desktop's side-by-side panes. Editing stays on desktop.
 */
export function MobileFilesScreen({ onBack }: MobileFilesScreenProps) {
  const intl = useIntl()
  const projects = useProjectStore((s) => s.projects)
  const activeWorkspaceId = useProjectStore((s) => s.activeWorkspaceId)

  const rootPath = useMemo(() => {
    if (activeWorkspaceId == null) return null
    for (const project of projects) {
      const workspace = project.workspaces.find((w) => w.id === activeWorkspaceId)
      if (workspace) return workspace.worktreePath ?? null
    }
    return null
  }, [projects, activeWorkspaceId])

  const [selected, setSelected] = useState<string | null>(null)
  const treeApiRef = useRef<WorkspaceFileTreeHandle | null>(null)

  // A file is open → full-screen preview with a back affordance in the header.
  if (selected != null) {
    return (
      <div
        className="flex h-full flex-col bg-background"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <FilePreviewPane
          selectedPath={selected}
          rootPath={rootPath}
          className="min-h-0 flex-1"
          leftAccessory={
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="-ml-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              <FormattedMessage id="mobile.files.title" defaultMessage="Files" />
            </button>
          }
        />
      </div>
    )
  }

  return (
    <div
      className="flex h-full flex-col bg-background"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/50 px-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          <FormattedMessage id="mobile.tab.more" defaultMessage="More" />
        </button>
        <span className="ml-1 text-sm font-semibold text-foreground/90">
          <FormattedMessage id="mobile.files.title" defaultMessage="Files" />
        </span>
        {rootPath != null && (
          <button
            type="button"
            onClick={() => treeApiRef.current?.refresh()}
            className="ml-auto flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50"
            aria-label={intl.formatMessage({ id: "common.refresh", defaultMessage: "Refresh" })}
          >
            <RefreshCw className="size-4" />
          </button>
        )}
      </div>

      {rootPath == null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <FolderTree className="size-6 text-muted-foreground/60" />
          <p className="text-sm font-medium text-foreground/85">
            <FormattedMessage id="mobile.files.noWorkspaceTitle" defaultMessage="No workspace selected" />
          </p>
          <p className="text-xs text-muted-foreground/70">
            <FormattedMessage
              id="mobile.files.noWorkspaceDesc"
              defaultMessage="Pick a workspace from the context bar, then reopen Files."
            />
          </p>
        </div>
      ) : (
        <WorkspaceFileTree
          key={rootPath}
          rootPath={rootPath}
          selectedPath={selected}
          onSelectFile={setSelected}
          apiRef={treeApiRef}
          className="min-h-0 flex-1"
        />
      )}
    </div>
  )
}
