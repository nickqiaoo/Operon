import { useEffect, useState } from "react"
import { AlertCircle, FolderOpen, Loader2 } from "lucide-react"
import { FormattedMessage, useIntl, type IntlShape } from "react-intl"
import { getFileIcon } from "@/components/FileIcon"
import { assistantApi } from "@/lib/assistant-api"
import { cn } from "@/lib/utils"
import type { AssistantWorkspaceFile } from "./types"
import { Empty } from "./ActivityTab"
import { formatClock, isSameDay } from "./shared"
import { dayLabel } from "./assistant-i18n"

interface FilesTabProps {
  /** The file open in the preview, highlighted in the list. */
  selectedPath: string | null
  /** `root`: the workspace, which the list already knows — nothing to resolve. */
  onOpen: (path: string, root: string) => void
  /** Changes when the assistant may have written something: the list is fetched again. */
  refreshKey: string
  /** The phone's page: bigger rows and day headings. */
  large?: boolean
  /** The outputs folder, once the listing knows it (for the heading's "Show in Finder"). */
  onDir?: (dir: string) => void
}

function formatSize(intl: IntlShape, bytes: number): string {
  if (bytes < 1024) return intl.formatNumber(bytes, { style: "unit", unit: "byte", unitDisplay: "narrow" })
  const kb = bytes / 1024
  if (kb < 1024) return intl.formatNumber(kb, { style: "unit", unit: "kilobyte", unitDisplay: "short", maximumFractionDigits: 0 })
  return intl.formatNumber(kb / 1024, { style: "unit", unit: "megabyte", unitDisplay: "short", maximumFractionDigits: 1 })
}

/** Opens the assistant's outputs folder in Finder. Desktop only: `null` where there is no Finder to open. */
export function RevealFolderButton({ dir }: { dir: string }) {
  const openInIde = __APP_TARGET__ !== "web" ? window.electronAPI?.openInIde : undefined
  if (!openInIde) return null
  return (
    <button
      type="button"
      onClick={() => void openInIde({ app: "finder", targetPath: dir })}
      title={dir}
      className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"
    >
      <FolderOpen className="h-3.5 w-3.5" />
      <FormattedMessage id="assistant.files.reveal" defaultMessage="Show in Finder" />
    </button>
  )
}

/**
 * What the assistant made for the user — plans, reports, documents: its outputs folder — newest
 * first, grouped by day. Not the rest of its workspace: the code and scratch files of getting there
 * stay out of sight.
 */
export function FilesTab({ selectedPath, onOpen, refreshKey, large, onDir }: FilesTabProps) {
  const intl = useIntl()
  const [listing, setListing] = useState<{ dir: string; files: AssistantWorkspaceFile[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    assistantApi
      .workspaceFiles()
      .then((result) => {
        if (cancelled) return
        setListing(result)
        setError(null)
        onDir?.(result.dir)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  if (listing == null) {
    return error != null ? (
      <div className="flex items-center gap-2 px-5 pt-4 text-xs text-destructive">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
      </div>
    ) : (
      <div className="flex items-center gap-2 px-5 pt-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> <FormattedMessage id="mobile.assistant.loading" defaultMessage="Loading…" />
      </div>
    )
  }

  const { dir, files } = listing

  return (
    <div className="px-2 pb-4">
      {files.length === 0 ? (
        <Empty
          text={intl.formatMessage({
            id: "assistant.files.empty",
            defaultMessage: "Nothing yet. What the assistant makes for you — plans, reports, documents — shows up here.",
          })}
        />
      ) : (
        <div className="space-y-1">
          {files.map((file, i) => {
            const slash = file.relativePath.lastIndexOf("/")
            const name = file.relativePath.slice(slash + 1)
            const folder = slash > 0 ? file.relativePath.slice(0, slash) : null
            return (
              <div key={file.path}>
                {(i === 0 || !isSameDay(files[i - 1].updatedAt, file.updatedAt)) && (
                  <div className={large ? "px-3 pb-1.5 pt-5 text-lg font-semibold" : "heading-section px-2 pb-1 pt-3"}>
                    {dayLabel(intl, file.updatedAt)}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => onOpen(file.path, dir)}
                  title={file.relativePath}
                  className={cn(
                    "flex w-full items-start text-left transition-colors",
                    large ? "gap-3.5 rounded-xl px-3 py-2.5 active:bg-secondary-active" : "gap-3 rounded-lg px-2 py-2",
                    selectedPath === file.path ? "bg-foreground/[0.07]" : "hover:bg-secondary-hover",
                  )}
                >
                  <span className={cn("flex shrink-0 items-center justify-center", large ? "mt-0.5 size-6" : "mt-0.5 h-4 w-4")}>
                    {getFileIcon(name, "h-full w-full")}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={cn("truncate text-foreground/90", large ? "text-[17px] font-semibold leading-snug" : "text-sm font-medium")}>
                      {name}
                    </div>
                    <div className={cn("flex items-center gap-1 text-muted-foreground/70", large ? "text-[13px]" : "text-[11px]")}>
                      <span className="shrink-0">{formatClock(file.updatedAt)}</span>
                      <span className="text-muted-foreground/50">·</span>
                      <span className="shrink-0">{formatSize(intl, file.size)}</span>
                      {folder && (
                        <>
                          <span className="text-muted-foreground/50">·</span>
                          <span className="truncate">{folder}</span>
                        </>
                      )}
                    </div>
                  </div>
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
