import { api } from "@/lib/api"

/**
 * Convert an absolute path returned by the FS API into the canonical path
 * string @pierre/trees uses: relative to root, with trailing "/" if the entry
 * is a directory.
 */
export function toTreePath(
  rootPath: string,
  absolutePath: string,
  isDirectory: boolean
): string {
  const normalizedRoot = rootPath.replace(/[\\/]+$/, "")
  const relative = absolutePath.startsWith(normalizedRoot + "/")
    ? absolutePath.slice(normalizedRoot.length + 1)
    : absolutePath
  return isDirectory ? `${relative.replace(/\/$/, "")}/` : relative
}

/** Reverse of toTreePath. */
export function toAbsolutePath(rootPath: string, treePath: string): string {
  const normalizedRoot = rootPath.replace(/[\\/]+$/, "")
  const trimmed = treePath.replace(/\/$/, "")
  return `${normalizedRoot}/${trimmed}`
}

/**
 * Load a directory's immediate children and return Pierre-formatted path
 * strings (one per child, with trailing "/" for subdirectories).
 */
export async function readDirAsTreePaths(
  rootPath: string,
  absoluteDirPath: string
): Promise<string[]> {
  const entries = await api.readDir(absoluteDirPath)
  return entries.map((entry) =>
    toTreePath(rootPath, entry.path, entry.isDirectory)
  )
}

/** True if the canonical tree path is a directory. */
export const isDirectoryPath = (treePath: string): boolean =>
  treePath.endsWith("/")

/** Last path segment of an absolute or tree path (trailing slash ignored). */
export const basename = (path: string): string =>
  path.replace(/\/+$/, "").split(/[\\/]/).pop() ?? path
