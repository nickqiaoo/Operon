import { FilePreviewPane } from "@/components/workspace-browser/FilePreviewPane"
import { basename } from "@/lib/workspace-files"
import { MobileSheet } from "./MobileSheet"

export interface MobileFilePreview {
  /** Absolute path. */
  path: string
  line?: number
  /** New on every tap, so tapping the same citation again jumps back to its line. */
  nonce: number
}

/**
 * A file a chat message cites, previewed in a sheet that rises over the chat.
 * Read-only: no toolbar, find, diff or line comments — just the file, at the line.
 */
export function MobileFilePreviewSheet({
  preview,
  rootPath,
  onClose,
}: {
  preview: MobileFilePreview | null
  rootPath: string | null
  onClose: () => void
}) {
  return (
    <MobileSheet
      open={preview != null}
      onClose={onClose}
      title={preview ? basename(preview.path) : undefined}
      sheetClassName="flex h-[85dvh] max-h-[85dvh] flex-col"
      bodyClassName="flex min-h-0 max-h-none flex-1 flex-col overflow-hidden px-0 pb-0"
    >
      {preview && (
        <FilePreviewPane
          selectedPath={preview.path}
          rootPath={rootPath}
          gotoLine={preview.line}
          gotoNonce={preview.nonce}
          // null (not undefined) drops the pane's own header bar and toolbar.
          toolbarSlot={null}
          toolbarEndSlot={null}
          workspaceTools={false}
          className="min-h-0 flex-1"
        />
      )}
    </MobileSheet>
  )
}
