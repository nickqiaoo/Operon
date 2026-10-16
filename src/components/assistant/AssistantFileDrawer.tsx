import { useCallback, useEffect, useState } from "react"
import { AlertCircle, FolderOpen, Loader2, X } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { FilePreviewPane } from "@/components/workspace-browser/FilePreviewPane"
import { assistantApi } from "@/lib/assistant-api"
import type { FileOpenHandler } from "@/lib/file-open-context"
import { DrawerShell, useDrawer } from "./Drawer"

interface ResolvedFile {
  /** Absolute. */
  path: string
  /** The folder the header shows the path from. */
  root: string | null
}

/** A file of the assistant's, opened from a reference in its reply or the Files tab. */
export interface OpenAssistantFile {
  /** As opened: absolute from the Files tab, as its reply wrote it from a reference. */
  path: string
  /** Already known (the Files tab): nothing to ask the server. */
  resolved?: ResolvedFile
  /** 1-based line to scroll to. */
  line?: number
  /** Changes on every open, so opening the same line again still jumps to it. */
  nonce: number
}

let lastNonce = 0

/** A file to open; `resolved` when its absolute path is already known. */
export function assistantFile(path: string, extra: { resolved?: ResolvedFile; line?: number } = {}): OpenAssistantFile {
  return { path, ...extra, nonce: ++lastNonce }
}

/**
 * Opens the files its replies refer to. They are its own — relative to its
 * workspace, not to whichever workspace is active in the app. Opens at once:
 * which file the path means is worked out in the view, behind a spinner, so a
 * tap never looks like it did nothing while the server answers.
 */
export function useAssistantFileOpener(onOpen: (file: OpenAssistantFile) => void): FileOpenHandler {
  return useCallback<FileOpenHandler>((path, options) => onOpen(assistantFile(path, { line: options?.line })), [onOpen])
}

/** The file `file` means, asked of the server unless it is already known. */
function useResolvedFile(file: OpenAssistantFile): ResolvedFile | "missing" | null {
  const [resolved, setResolved] = useState<ResolvedFile | "missing" | null>(file.resolved ?? null)
  useEffect(() => {
    if (file.resolved) {
      setResolved(file.resolved)
      return
    }
    let cancelled = false
    setResolved(null)
    assistantApi
      .resolveFile(file.path)
      .then((result) => {
        if (!cancelled) setResolved(result)
      })
      .catch(() => {
        if (!cancelled) setResolved("missing")
      })
    return () => {
      cancelled = true
    }
  }, [file.path, file.resolved])
  return resolved
}

interface AssistantFileDrawerProps {
  file: OpenAssistantFile | null
  onClose: () => void
}

/** A file the assistant wrote, read beside the thread: rendered markdown, source, or the image. */
export function AssistantFileDrawer({ file, onClose }: AssistantFileDrawerProps) {
  const { shown, active } = useDrawer(file, onClose)
  if (!shown) return null
  return (
    <DrawerShell active={active} className="w-[720px]">
      <AssistantFileView key={shown.nonce} file={shown} onClose={onClose} />
    </DrawerShell>
  )
}

const ICON_BUTTON =
  "flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"

/** The preview itself, shared with the phone's page (which brings its own back bar, so no close button). */
export function AssistantFileView({ file, onClose }: { file: OpenAssistantFile; onClose?: () => void }) {
  const intl = useIntl()
  const resolved = useResolvedFile(file)
  const ready = resolved != null && resolved !== "missing" ? resolved : null
  const reveal =
    ready && __APP_TARGET__ !== "web" && window.electronAPI?.openInIde
      ? () => void window.electronAPI?.openInIde({ app: "finder", targetPath: ready.path })
      : null
  const closeButton = onClose && (
    <button type="button" onClick={onClose} title={intl.formatMessage({ id: "assistant.close", defaultMessage: "Close" })} className={ICON_BUTTON}>
      <X className="h-4 w-4" />
    </button>
  )

  if (!ready) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {closeButton && <div className="flex h-10 shrink-0 items-center justify-end border-b border-border/50 px-2">{closeButton}</div>}
        {resolved === "missing" ? (
          <div className="flex flex-1 items-center justify-center gap-2 px-6 text-center text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <FormattedMessage id="assistant.files.notFound" defaultMessage="File not found: {path}" values={{ path: file.path }} />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <FormattedMessage id="mobile.assistant.loading" defaultMessage="Loading…" />
          </div>
        )}
      </div>
    )
  }

  return (
    <FilePreviewPane
      className="min-h-0 flex-1"
      selectedPath={ready.path}
      rootPath={ready.root}
      gotoLine={file.line}
      gotoNonce={file.line != null ? file.nonce : undefined}
      workspaceTools={false}
      rightAccessory={
        reveal || closeButton ? (
          <>
            {reveal && (
              <button
                type="button"
                onClick={reveal}
                title={intl.formatMessage({ id: "assistant.files.reveal", defaultMessage: "Show in Finder" })}
                className={ICON_BUTTON}
              >
                <FolderOpen className="h-4 w-4" />
              </button>
            )}
            {closeButton}
          </>
        ) : null
      }
    />
  )
}
