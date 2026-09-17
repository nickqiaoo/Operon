import { useEffect, useRef, useState, type ReactNode } from "react"
import { useIntl } from "react-intl"
import { ArrowLeft, ArrowRight, ExternalLink, Folders, RefreshCw, X } from "lucide-react"
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
import {
  closePreviewFile,
  openPreviewFile,
  previewFilesOf,
} from "@/lib/workspace-preview-files"
import { FileIcon } from "@/components/FileIcon"
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
  openPaths?: string[]
  recentPaths?: string[]
  gotoLine?: number
  gotoNonce?: number
}

/**
 * Single tab combining file tree (right) and file preview (left), matching
 * Codex's design. Selecting a file in the tree opens it in the preview strip
 * next to the files already open (evicting the least recently viewed past
 * `MAX_PREVIEW_FILES`) and makes it `payload.selectedPath`. The tree and
 * preview are shared with the mobile Files screen via {@link WorkspaceFileTree}
 * and {@link FilePreviewPane}.
 */
export function WorkspaceBrowserTab({
  panelId,
  tabId,
  rootPath,
  selectedPath,
  openPaths,
  recentPaths,
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

  const files = previewFilesOf({ selectedPath, openPaths, recentPaths })

  const showFile = (absolutePath: string) => {
    updateTab(panelId, tabId, {
      title: basename(absolutePath),
      payload: {
        type: "workspace-browser",
        rootPath,
        selectedPath: absolutePath,
        ...openPreviewFile(files, absolutePath),
      },
    })
  }

  const closeFile = (absolutePath: string) => {
    const next = closePreviewFile(files, absolutePath, selectedPath)
    updateTab(panelId, tabId, {
      title: next.selectedPath != null ? basename(next.selectedPath) : basename(rootPath),
      payload: { type: "workspace-browser", rootPath, ...next },
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

  const previewAccessory = isTreeVisible ? null : (
    <>
      {backButton}
      {forwardButton}
      {openInEditorButton}
      {refreshButton}
      {toggleButton}
    </>
  )

  return (
    // data-find-scope: ⌘F in the tree searches the file on screen too.
    <div data-find-scope className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {files.openPaths.length > 1 && (
          <PreviewFileStrip
            openPaths={files.openPaths}
            selectedPath={selectedPath}
            onSelect={showFile}
            onClose={closeFile}
          />
        )}
        {/* Every open file stays mounted so switching back keeps its scroll
            position, view mode and find state; only the selected one shows. */}
        <div className="relative min-h-0 flex-1">
          {files.openPaths.length === 0 || selectedPath == null ? (
            <FilePreviewPane
              selectedPath={null}
              rightAccessory={previewAccessory}
              className="absolute inset-0"
            />
          ) : (
            files.openPaths.map((path) => {
              const isSelected = path === selectedPath
              return (
                <FilePreviewPane
                  key={path}
                  selectedPath={path}
                  rootPath={rootPath}
                  active={isSelected}
                  gotoLine={isSelected ? gotoLine : undefined}
                  gotoNonce={isSelected ? gotoNonce : undefined}
                  reloadNonce={previewReloadNonce}
                  rightAccessory={previewAccessory}
                  className={cn("absolute inset-0 bg-background", !isSelected && "invisible")}
                />
              )
            })
          )}
        </div>
      </div>
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
 * The files open in this tab's preview. Only shown once a second file is open —
 * with one file the preview header's breadcrumb already says what's on screen.
 */
function PreviewFileStrip({
  openPaths,
  selectedPath,
  onSelect,
  onClose,
}: {
  openPaths: string[]
  selectedPath: string | null
  onSelect: (path: string) => void
  onClose: (path: string) => void
}) {
  const intl = useIntl()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const names = openPaths.map((path) => basename(path))

  // Keep the selected file in view when it was opened off-screen.
  // Not `scrollIntoView`: that also walks every scrollable ancestor, forcing a
  // layout of all the mounted previews each step (~3s with two long markdown
  // files open). Only the strip itself needs to move.
  useEffect(() => {
    const strip = scrollRef.current
    const tab = strip?.querySelector<HTMLElement>('[data-selected="true"]')
    if (strip == null || tab == null) return
    // The strip is `relative`, so offsetLeft is measured from its padding edge.
    const left = tab.offsetLeft
    const right = left + tab.offsetWidth
    if (left < strip.scrollLeft) strip.scrollLeft = left
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth
  }, [selectedPath])

  return (
    <div
      ref={scrollRef}
      onWheel={(e) => {
        if (scrollRef.current != null && e.deltaX === 0) scrollRef.current.scrollLeft += e.deltaY
      }}
      className="relative flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/50 px-2"
      style={{ scrollbarWidth: "none" }}
    >
      {openPaths.map((path, index) => {
        const name = names[index]
        const isSelected = path === selectedPath
        // Two open `index.ts` need their folder to be told apart.
        const parent =
          names.indexOf(name) !== names.lastIndexOf(name)
            ? basename(path.slice(0, path.length - name.length - 1))
            : null
        return (
          <div
            key={path}
            data-selected={isSelected ? "true" : undefined}
            title={path}
            onMouseDown={(e) => {
              // Middle click closes, like browser and editor tabs.
              if (e.button === 1) {
                e.preventDefault()
                onClose(path)
              }
            }}
            className={cn(
              "group flex h-7 max-w-48 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg pl-2 pr-1 text-xs transition-colors",
              // The selected tab sits on the base secondary surface — the pressed
              // `secondary-active` read as a dark block against the white pane.
              // Hover matches it so an unselected tab never looks heavier than
              // the selected one; text color still tells them apart.
              isSelected
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            )}
            onClick={() => onSelect(path)}
          >
            <FileIcon name={name} className="size-3.5 shrink-0" />
            <span className="truncate">{name}</span>
            {parent != null && (
              <span className="shrink-0 truncate text-muted-foreground/70">{parent}</span>
            )}
            <button
              type="button"
              aria-label={intl.formatMessage(
                { id: "workspaceBrowser.closeFile", defaultMessage: "Close {name}" },
                { name }
              )}
              onClick={(e) => {
                e.stopPropagation()
                onClose(path)
              }}
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary-active hover:text-foreground",
                isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              )}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
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
