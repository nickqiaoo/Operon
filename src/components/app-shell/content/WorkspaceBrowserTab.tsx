import { useEffect, useRef, useState, type ReactNode } from "react"
import { useIntl } from "react-intl"
import { ArrowLeft, ArrowRight, FileDiff, Folders, RefreshCw, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  SIDE_FILE_TREE_DEFAULT_WIDTH,
  clampSideFileTreeWidth,
} from "../constants"
import { OpenWithMenu } from "../OpenWithMenu"
import { ResizeHandle } from "../ResizeHandle"
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
import { useGitRepoInvalidation } from "@/lib/git-queries"
import { useChangedFiles, useDiffBase } from "@/components/workspace-browser/useFileBaseDiff"
import { useFilePreviewDiffStore } from "@/stores/file-preview-diff-store"
import {
  TOOLBAR_ICON_BUTTON,
  TOOLBAR_ICON_BUTTON_ON,
} from "@/components/ui/toolbar-styles"
import { PANEL_TAB_CLOSE_CLASS, panelTabClass } from "../tabs/TabBarItem"
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
 * Codex's design: one row of capsules across the top (left: the shown file's
 * view — preview / source, change navigation, comparison base; right: find,
 * outline, back/forward, refresh, the diff and tree toggles and "Open"), the preview and
 * tree side by side below it. Selecting a file in the tree opens it in the preview strip
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
  // The toolbar's left part, filled by whichever preview pane is on screen.
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null)
  // Its right part's head: the shown file's find / outline buttons.
  const [toolbarEndSlot, setToolbarEndSlot] = useState<HTMLDivElement | null>(null)
  // Git badges in the tree, against the same base as the preview's diff. The
  // repo watcher keeps them (and the diffs) current as files change on disk.
  useGitRepoInvalidation(rootPath)
  const changedFiles = useChangedFiles(rootPath, true)
  const diffAvailable = useDiffBase(rootPath, true).available
  const diffEnabled = useFilePreviewDiffStore((s) => s.enabled)
  const setDiffEnabled = useFilePreviewDiffStore((s) => s.setEnabled)

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
      className={TOOLBAR_ICON_BUTTON}
    >
      <RefreshCw className="h-3.5 w-3.5" />
    </button>
  )

  // Shows / hides the changed lines in the preview; the tree's badges stay.
  const diffLabel = diffEnabled
    ? intl.formatMessage({ id: "filePreview.diff.hide", defaultMessage: "Hide changes" })
    : intl.formatMessage({ id: "filePreview.diff.show", defaultMessage: "Show changes" })
  const diffToggle = diffAvailable ? (
    <button
      type="button"
      onClick={() => setDiffEnabled(!diffEnabled)}
      aria-label={diffLabel}
      aria-pressed={diffEnabled}
      title={diffLabel}
      className={cn(TOOLBAR_ICON_BUTTON, diffEnabled && TOOLBAR_ICON_BUTTON_ON)}
    >
      <FileDiff className="h-3.5 w-3.5" />
    </button>
  ) : null

  const toggleButton = (
    <button
      type="button"
      onClick={() => toggleWorkspaceTree(tabId)}
      aria-label={isTreeVisible ? "Hide file tree" : "Show file tree"}
      aria-pressed={isTreeVisible}
      title={isTreeVisible ? "Hide file tree" : "Show file tree"}
      // Match Codex: same `Folders` glyph in both states; the button is filled
      // while the pane is open and ghost (hover-only) while closed.
      className={cn(TOOLBAR_ICON_BUTTON, isTreeVisible && TOOLBAR_ICON_BUTTON_ON)}
    >
      <Folders className="h-3.5 w-3.5" />
    </button>
  )

  return (
    // data-find-scope: ⌘F in the tree searches the file on screen too.
    // @container: the toolbar drops labels / history arrows when the panel is narrow.
    <div data-find-scope className="@container flex h-full min-h-0 flex-col">
      {files.openPaths.length > 1 && (
        <PreviewFileStrip
          openPaths={files.openPaths}
          selectedPath={selectedPath}
          onSelect={showFile}
          onClose={closeFile}
        />
      )}
      <div className="flex h-12 shrink-0 items-center gap-1.5 px-2">
        <div ref={setToolbarSlot} className="flex min-w-0 flex-1 items-center gap-1.5" />
        <div className="flex shrink-0 items-center gap-0.5">
          <div ref={setToolbarEndSlot} className="flex items-center gap-0.5 empty:hidden" />
          <div className="flex items-center gap-0.5 @max-[640px]:hidden">
            {backButton}
            {forwardButton}
          </div>
          {refreshButton}
          {diffToggle}
          {toggleButton}
          <div className="ml-1">
            <OpenWithMenu targetPath={selectedPath ?? rootPath} />
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* Every open file stays mounted so switching back keeps its scroll
            position, view mode and find state; only the selected one shows. */}
        <div className="relative min-w-0 flex-1">
          {files.openPaths.length === 0 || selectedPath == null ? (
            <FilePreviewPane
              selectedPath={null}
              toolbarSlot={toolbarSlot}
              toolbarEndSlot={toolbarEndSlot}
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
                  toolbarSlot={toolbarSlot}
                  toolbarEndSlot={toolbarEndSlot}
                  gitChanges
                  className={cn("absolute inset-0 bg-background", !isSelected && "invisible")}
                />
              )
            })
          )}
        </div>
        {isTreeVisible && (
          <>
            <div className="w-px shrink-0 bg-border/50" />
            <div
              ref={fileTreeRef}
              className="relative flex shrink-0 flex-col"
              style={{ width: fileTreeWidth, maxWidth: "50%" }}
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
              <WorkspaceFileTree
                rootPath={rootPath}
                selectedPath={selectedPath}
                onSelectFile={showFile}
                apiRef={treeApiRef}
                gitStatus={changedFiles}
                className="min-h-0 flex-1"
              />
            </div>
          </>
        )}
      </div>
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
      className="relative flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 px-2"
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
            className={panelTabClass(isSelected)}
            onClick={() => onSelect(path)}
          >
            <FileIcon name={name} className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{name}</span>
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
              className={PANEL_TAB_CLOSE_CLASS}
            >
              <X className="h-3.5 w-3.5" />
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
      className={TOOLBAR_ICON_BUTTON}
    >
      {children}
    </button>
  )
}
