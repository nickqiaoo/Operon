import { useCallback, type ReactNode } from 'react'
import { api } from '@/lib/api'
import { resolveCitationFile } from '@/lib/file-citation'
import { CitationRootProvider, FileOpenProvider, type FileOpenHandler } from '@/lib/file-open-context'
import { openWorkspaceFilePreview } from '@/lib/workspace-file-preview'

/** References in an output belong to its source, independently of navigation. */
export function ScopedFileReferences({ rootPath, children }: { rootPath: string | null; children: ReactNode }) {
  const openFile = useCallback<FileOpenHandler>((path, options) => {
    const absolute = resolveCitationFile(rootPath, path)
    if (!absolute || !rootPath) return
    // Recheck on click: cleanup may have happened since the citation was rendered.
    void api.stat(absolute).then((stat) => {
      if (stat.isFile) openWorkspaceFilePreview(absolute, { ...options, rootPath })
    }).catch(() => undefined)
  }, [rootPath])
  return (
    <CitationRootProvider value={rootPath}>
      <FileOpenProvider value={openFile}>{children}</FileOpenProvider>
    </CitationRootProvider>
  )
}
