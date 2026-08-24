import { useCallback, type HTMLAttributes, type MouseEvent } from "react"
import { getFileIcon } from "@/components/FileIcon"
import { formatLineLabel, decodeCitation, type FileReference } from "@/lib/file-citation"
import { openWorkspaceFilePreview } from "@/lib/workspace-file-preview"
import { cn } from "@/lib/utils"

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
 * Clicking resolves the path against the active workspace and opens it in the
 * side file viewer, scrolling to the referenced line.
 */
export function FileCitationChip({ path, line, endLine, className }: FileCitationChipProps) {
  const basename = getBasename(cleanPath(path))
  const lineLabel = formatLineLabel(line, endLine)

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault()
      openWorkspaceFilePreview(
        cleanPath(path),
        line != null ? { line } : undefined
      )
    },
    [path, line]
  )

  return (
    <button
      type="button"
      onClick={handleClick}
      title={path}
      className={cn(
        "inline-flex max-w-full appearance-none items-baseline gap-1 border-0 bg-transparent p-0 align-baseline text-[1em] text-link no-underline transition-colors [font:inherit] [line-height:inherit] hover:text-link/85 hover:underline hover:decoration-link/40 underline-offset-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
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
