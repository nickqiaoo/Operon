import { createContext, useContext } from "react"
import { openWorkspaceFilePreview } from "@/lib/workspace-file-preview"

/** Opens a file a message refers to (a citation chip, a local-path link). */
export type FileOpenHandler = (path: string, options?: { line?: number }) => void

const openInWorkspace: FileOpenHandler = (path, options) => {
  openWorkspaceFilePreview(path, options)
}

const FileOpenContext = createContext<FileOpenHandler>(openInWorkspace)

/**
 * Where file references inside it open. Outside any provider they resolve
 * relative paths against the active workspace. Absolute paths can open their
 * own file tree; other surfaces (the assistant) provide their own handler.
 */
export const FileOpenProvider = FileOpenContext.Provider

export function useFileOpenHandler(): FileOpenHandler {
  return useContext(FileOpenContext)
}

// undefined preserves ordinary chat behavior; null disables relative references without a source.
const CitationRootContext = createContext<string | null | undefined>(undefined)
export const CitationRootProvider = CitationRootContext.Provider
export function useCitationRoot() { return useContext(CitationRootContext) }
