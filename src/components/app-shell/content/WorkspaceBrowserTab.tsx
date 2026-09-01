import { useEffect, useRef, useState, type ReactNode } from "react"
import { useIntl } from "react-intl"
import { ArrowLeft, ArrowRight, ExternalLink, Folders, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  SIDE_FILE_TREE_DEFAULT_WIDTH,
  clampSideFileTreeWidth,
} from "../constants"
import { ResizeHandle } from "../ResizeHandle"
import { useOpenWith } from "../useOpenWith"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useTabsStore } from "@/stores/tabs-store"
import { basename } from "@/lib/workspace-files"
import { FilePreviewPane } from "@/components/workspace-browser/FilePreviewPane"
import {
  WorkspaceFileTree,
  type WorkspaceFileTreeHandle,
} from "@/components/workspace-browser/WorkspaceFileTree"
import type { PanelId } from "../tabs/types"

interface WorkspaceBrowserTabProps {
  panelId: PanelId
  tabId: string
  rootPath: string
  selectedPath: string | null
  gotoLine?: number
  gotoNonce?: number
}

/**
 * Single tab combining file tree (right) and file preview (left), matching
 * Codex's design. Selecting a file in the tree updates `payload.selectedPath`
 * and the tab title; the preview area renders the file content. The tree and
 * preview are shared with the mobile Files screen via {@link WorkspaceFileTree}
 * and {@link FilePreviewPane}.
 */
export function WorkspaceBrowserTab({
  panelId,
  tabId,
  rootPath,
  selectedPath,
  gotoLine,
  gotoNonce,
}: WorkspaceBrowserTabProps) {
  const intl = useIntl()
  const treeApiRef = useRef<WorkspaceFileTreeHandle | null>(null)
  const fileTreeRef = useRef<HTMLDivElement | null>(null)
  const isTreeVisible = useAppShellStore((s) => !s.workspaceTreeHidden[tabId])
  const toggleWorkspaceTree = useAppShellStore((s) => s.toggleWorkspaceTree)
  const updateTab = useTabsStore((s) => s.updateTab)
  const previewHistory = useAppShellStore((s) => s.workspacePreviewHistory[tabId])
  const pushPreviewHistory = useAppShellStore((s) => s.pushWorkspacePreviewHistory)
  const stepPreviewHistory = useAppShellStore((s) => s.stepWorkspacePreviewHistory)
  // Bumped by the refresh button to force FilePreviewPane to re-read the file.
  const [previewReloadNonce, setPreviewReloadNonce] = useState(0)
  const [fileTreeWidth, setFileTreeWidth] = useState(
    SIDE_FILE_TREE_DEFAULT_WIDTH
  )

  const historyIndex = previewHistory?.index ?? -1
  const historyLength = previewHistory?.entries.length ?? 0
  const canGoBack = historyIndex > 0
  const canGoForward = historyIndex >= 0 && historyIndex < historyLength - 1

  // Records every file the preview lands on, wherever the navigation came
  // from — the tree, a file citation in chat, `openWorkspaceFilePreview`. Going
  // back/forward moves the cursor first, so the push below sees the path it is
  // already parked on and does nothing.
  useEffect(() => {
    if (selectedPath == null) return
    pushPreviewHistory(tabId, selectedPath)
  }, [pushPreviewHistory, selectedPath, tabId])

  const showFile = (absolutePath: string) => {
    updateTab(panelId, tabId, {
      title: basename(absolutePath),
      payload: {
        type: "workspace-browser",
        rootPath,
        selectedPath: absolutePath,
      },
    })
  }

  const goHistory = (delta: number) => {
    const path = stepPreviewHistory(tabId, delta)
    if (path == null) return
    showFile(path)
  }

  const backButton = (
    <HistoryNavButton
      label={intl.formatMessage({
        id: "workspaceBrowser.previousFile",
        defaultMessage: "Previous file",
      })}
      disabled={!canGoBack}
      onClick={() => goHistory(-1)}
    >
      <ArrowLeft className="h-3.5 w-3.5" />
    </HistoryNavButton>
  )

  const forwardButton = (
    <HistoryNavButton
      label={intl.formatMessage({
        id: "workspaceBrowser.nextFile",
        defaultMessage: "Next file",
      })}
      disabled={!canGoForward}
      onClick={() => goHistory(1)}
    >
      <ArrowRight className="h-3.5 w-3.5" />
    </HistoryNavButton>
  )

  const refreshButton = (
    <button
      type="button"
      onClick={() => {
        treeApiRef.current?.refresh()
        setPreviewReloadNonce((n) => n + 1)
      }}
      aria-label={intl.formatMessage({ id: "common.refresh", defaultMessage: "Refresh" })}
      title={intl.formatMessage({ id: "workspaceBrowser.refreshTitle", defaultMessage: "Refresh file tree and preview" })}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      <RefreshCw className="h-3.5 w-3.5" />
    </button>
  )

  const toggleButton = (
    <button
      type="button"
      onClick={() => toggleWorkspaceTree(tabId)}
      aria-label={isTreeVisible ? "Hide file tree" : "Show file tree"}
      aria-pressed={isTreeVisible}
      title={isTreeVisible ? "Hide file tree" : "Show file tree"}
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors",
        // Match Codex: same `Folders` glyph in both states; the *button*
        // toggles between secondary (filled) when the pane is open and
        // ghost (hover-only) when closed.
        isTreeVisible
          ? "bg-muted/60 text-foreground hover:bg-muted/80"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      )}
    >
      <Folders className="h-3.5 w-3.5" />
    </button>
  )

  // Sits in the right-side toolbar next to refresh/toggle; only when a file is
  // selected. Opens the previewed file in the preferred "Open with…" app.
  const openInEditorButton =
    selectedPath != null ? <OpenInEditorButton filePath={selectedPath} /> : null

  return (
    <div className="flex h-full min-h-0">
      <FilePreviewPane
        selectedPath={selectedPath}
        rootPath={rootPath}
        gotoLine={gotoLine}
        gotoNonce={gotoNonce}
        reloadNonce={previewReloadNonce}
        rightAccessory={
          isTreeVisible ? null : (
            <>
              {backButton}
              {forwardButton}
              {openInEditorButton}
              {refreshButton}
              {toggleButton}
            </>
          )
        }
        className="min-w-0 flex-1"
      />
      {isTreeVisible && (
        <>
          <div className="w-px shrink-0 bg-border/50" />
          <div
            ref={fileTreeRef}
            className="relative flex shrink-0 flex-col"
            style={{ width: fileTreeWidth }}
          >
            <ResizeHandle
              edge="left"
              defaultSize={SIDE_FILE_TREE_DEFAULT_WIDTH}
              getSizeFromPointer={({ x }) => {
                const right =
                  fileTreeRef.current?.getBoundingClientRect().right ??
                  window.innerWidth
                return right - x
              }}
              setSize={(next) =>
                setFileTreeWidth(clampSideFileTreeWidth(next))
              }
            />
            <div className="flex h-10 shrink-0 items-center justify-end gap-0.5 border-b border-border/50 px-2">
              {backButton}
              {forwardButton}
              {openInEditorButton}
              {refreshButton}
              {toggleButton}
            </div>
            <WorkspaceFileTree
              rootPath={rootPath}
              selectedPath={selectedPath}
              onSelectFile={showFile}
              apiRef={treeApiRef}
              className="min-h-0 flex-1"
            />
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Back / forward arrow for the preview history. Matches the in-app browser's
 * NavButton so the two toolbars read the same, including the dimmed,
 * hover-inert disabled state at either end of the history.
 */
function HistoryNavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
    >
      {children}
    </button>
  )
}

/**
 * Header button that opens the previewed file in the user's preferred external
 * app — the same app the top-bar "Open with…" dropdown points at (shared via
 * useOpenWith), so changing it in one place updates both. Hidden when no app is
 * available (non-macOS / nothing resolved).
 */
function OpenInEditorButton({ filePath }: { filePath: string }) {
  const { available, preferredApp, open } = useOpenWith()
  if (!available || preferredApp == null) return null
  return (
    <button
      type="button"
      onClick={() => void open(filePath)}
      aria-label={`Open in ${preferredApp.label}`}
      title={`Open in ${preferredApp.label}`}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </button>
  )
}
