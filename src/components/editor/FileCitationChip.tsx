import { useCallback, useEffect, useState, type HTMLAttributes, type MouseEvent } from "react"
import { getFileIcon } from "@/components/FileIcon"
import { formatLineLabel, decodeCitation, resolveCitationFile, type FileReference } from "@/lib/file-citation"
import { useCitationRoot, useFileOpenHandler } from "@/lib/file-open-context"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"

function getBasename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** Normalizes a model-written path: drops `./` and diff `a/` `b/` prefixes. */
function cleanPath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^[ab]\//, "")
}

type FileCitationChipProps = FileReference & {
  className?: string
}

/**
 * Renders an inline, clickable file reference (file-type icon + name + line).
 * Clicking opens the file where the surrounding surface opens files (see
 * {@link useFileOpenHandler}) — by default the active workspace's side file
 * viewer — scrolled to the referenced line.
 */
export function FileCitationChip({ path, line, endLine, className }: FileCitationChipProps) {
  const openFile = useFileOpenHandler()
  const rootPath = useCitationRoot()
  const target = rootPath === undefined ? null : resolveCitationFile(rootPath, cleanPath(path))
  const [available, setAvailable] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (target) void api.stat(target).then((stat) => {
      if (!cancelled) setAvailable(stat.isFile ? target : null)
    }).catch(() => { if (!cancelled) setAvailable(null) })
    return () => { cancelled = true }
  }, [target])
  const basename = getBasename(cleanPath(path))
  // The prompt has the model cite a whole file as L1: that is "this file", not a place in it.
  const wholeFile = line === 1 && (endLine == null || endLine === 1)
  const lineLabel = wholeFile ? null : formatLineLabel(line, endLine)

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault()
      openFile(cleanPath(path), line != null && !wholeFile ? { line } : undefined)
    },
    [openFile, path, line, wholeFile]
  )

  if (rootPath !== undefined && (!target || available !== target)) {
    return <span title={path} className={className}>{basename}{wholeFile || line == null ? '' : `:${line}${endLine != null && endLine !== line ? `-${endLine}` : ''}`}</span>
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={path}
      className={cn(
        "inline-flex max-w-full appearance-none items-baseline gap-1 border-0 bg-transparent p-0 align-baseline text-[1em] text-link no-underline transition-colors [font:inherit] [line-height:inherit] hover:text-link/75 active:text-link/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className
      )}
    >
      <span className="relative top-[0.06em] inline-flex h-[0.78em] w-[0.78em] shrink-0 items-center justify-center">
        {getFileIcon(basename, "h-full w-full")}
      </span>
      <span className="truncate">{basename}</span>
      {lineLabel != null && <span className="whitespace-nowrap">({lineLabel})</span>}
    </button>
  )
}

/**
 * Markdown `inlineCode` component. A citation token (`【F:src/app.ts†L42】`) is
 * rewritten by {@link remarkFileCitations} into an inline-code node whose value
 * carries the encoded citation; here we decode it and render a clickable
 * {@link FileCitationChip}. Everything else is ordinary inline code — we no
 * longer guess whether a path-looking token is a real file.
 */
export function InlineFileCode({ children, className, ...props }: HTMLAttributes<HTMLElement>) {
  const value =
    typeof children === "string"
      ? children
      : Array.isArray(children)
        ? children.join("")
        : ""
  const fileRef = value ? decodeCitation(value) : null
  if (fileRef) {
    return <FileCitationChip {...fileRef} />
  }
  return (
    <code
      className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-sm", className)}
      data-streamdown="inline-code"
      {...props}
    >
      {children}
    </code>
  )
}
