import fsPromises from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import fuzzysort from 'fuzzysort'
import type { FileInfo, FileStat } from '../types/fs.js'

const DEFAULT_PATH_SEARCH_LIMIT = 50
const MAX_PATH_SEARCH_LIMIT = 200
const MAX_SCANNED_DIRECTORIES = 4000
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'out',
  'coverage',
])

const normalizePathSeparators = (value: string) => value.replace(/\\/g, '/')

const FILE_MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  css: 'text/css; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  gif: 'image/gif',
  htm: 'text/html; charset=utf-8',
  html: 'text/html; charset=utf-8',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  webp: 'image/webp',
  xml: 'application/xml; charset=utf-8',
}

const getFileMediaType = (filePath: string): string => {
  const extension = path.extname(filePath).slice(1).toLowerCase()
  if (!extension) return 'application/octet-stream'
  return FILE_MEDIA_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

export async function readDir(dirPath: string): Promise<FileInfo[]> {
  const entries = await fsPromises.readdir(dirPath, { withFileTypes: true })
  return entries
    .map((entry) => ({
      name: entry.name,
      path: path.join(dirPath, entry.name),
      isDirectory: entry.isDirectory(),
    }))
    .sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.name.localeCompare(b.name)
    })
}

export async function findPaths(rootPath: string, query: string, limit = DEFAULT_PATH_SEARCH_LIMIT): Promise<FileInfo[]> {
  const trimmedQuery = query.trim().toLowerCase()
  if (!trimmedQuery) return []

  const cappedLimit = Math.max(1, Math.min(limit, MAX_PATH_SEARCH_LIMIT))
  const results: FileInfo[] = []
  const queue: string[] = [rootPath]
  const visitedDirectories = new Set<string>()
  let scannedDirectories = 0

  while (queue.length > 0 && results.length < cappedLimit && scannedDirectories < MAX_SCANNED_DIRECTORIES) {
    const currentPath = queue.shift()
    if (!currentPath || visitedDirectories.has(currentPath)) continue

    visitedDirectories.add(currentPath)
    scannedDirectories += 1

    try {
      const entries = await fsPromises.readdir(currentPath, { withFileTypes: true })

      entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })

      for (const entry of entries) {
        if (entry.name === '.git') continue

        const fullPath = path.join(currentPath, entry.name)
        const relativePath = normalizePathSeparators(path.relative(rootPath, fullPath))
        const lowerName = entry.name.toLowerCase()
        const lowerRelativePath = relativePath.toLowerCase()
        const isDirectory = entry.isDirectory()

        if (lowerName.includes(trimmedQuery) || lowerRelativePath.includes(trimmedQuery)) {
          results.push({
            name: entry.name,
            path: fullPath,
            isDirectory,
          })
          if (results.length >= cappedLimit) break
        }

        if (!isDirectory) continue
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        if (entry.isSymbolicLink()) continue

        queue.push(fullPath)
      }
    } catch {
      continue
    }
  }

  return results
}

const SEARCH_FILES_LIMIT = 200
/** Past this many files a workspace is listed only this far (a home folder opened by mistake). */
const MAX_LISTED_FILES = 200_000
/** How long a workspace's file list is reused across keystrokes before it's read again. */
const FILE_LIST_TTL_MS = 5_000

const execFileAsync = promisify(execFile)
const fileListCache = new Map<string, { at: number; files: Promise<string[]> }>()

/**
 * Every file under `rootPath`, relative to it. A git repo answers with
 * `git ls-files` — tracked plus untracked-but-not-ignored, so `.gitignore`
 * decides what's in (no node_modules, no build output) and it takes ms.
 * Anything else is walked, skipping the usual dependency and build folders.
 */
async function listWorkspaceFiles(rootPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: rootPath,
      maxBuffer: 256 * 1024 * 1024,
    })
    return stdout.split('\0').filter(Boolean).slice(0, MAX_LISTED_FILES)
  } catch {
    // Not a git repo (or no git): walk it.
  }
  const files: string[] = []
  const queue: string[] = [rootPath]
  while (queue.length > 0 && files.length < MAX_LISTED_FILES) {
    const dir = queue.shift()!
    let entries: import('fs').Dirent[]
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.isSymbolicLink()) queue.push(fullPath)
      } else {
        files.push(normalizePathSeparators(path.relative(rootPath, fullPath)))
      }
    }
  }
  return files
}

function cachedWorkspaceFiles(rootPath: string): Promise<string[]> {
  const cached = fileListCache.get(rootPath)
  if (cached && Date.now() - cached.at < FILE_LIST_TTL_MS) return cached.files
  const files = listWorkspaceFiles(rootPath)
  fileListCache.set(rootPath, { at: Date.now(), files })
  files.catch(() => fileListCache.delete(rootPath))
  return files
}

/**
 * Fuzzy file search over the whole workspace, like an editor's quick open:
 * `wbt` finds `WorkspaceBrowserTab.tsx`. The name and the full path are both
 * matched and a name match ranks a little higher; a query with `/` in it
 * naturally matches along the path. Paths come back relative to `rootPath`,
 * best first.
 */
export async function searchFiles(rootPath: string, query: string, limit = SEARCH_FILES_LIMIT): Promise<string[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const files = await cachedWorkspaceFiles(rootPath)
  const targets = files.map((file) => ({ path: file, name: path.posix.basename(file) }))
  const results = fuzzysort.go(trimmed, targets, {
    keys: ['name', 'path'],
    limit: Math.max(1, Math.min(limit, SEARCH_FILES_LIMIT)),
    // Among equal matches the shallower file wins: the root README before deploy/README.
    scoreFn: (r) =>
      Math.max(r[0]?.score ?? 0, (r[1]?.score ?? 0) * 0.9) - r.obj.path.split('/').length * 0.001,
  })
  return results.map((r) => r.obj.path)
}

export async function readFile(filePath: string): Promise<string> {
  return fsPromises.readFile(filePath, 'utf-8')
}

export async function readFileAsset(filePath: string): Promise<{ buffer: Uint8Array; mediaType: string }> {
  const buffer = await fsPromises.readFile(filePath)
  return {
    buffer,
    mediaType: getFileMediaType(filePath),
  }
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  await fsPromises.writeFile(filePath, content, 'utf-8')
}

export async function saveTempFile(content: string, extension = '.txt'): Promise<string> {
  const tempDir = os.tmpdir()
  const fileName = `operon-attachment-${randomUUID()}${extension}`
  const filePath = path.join(tempDir, fileName)
  await fsPromises.writeFile(filePath, content, 'utf-8')
  return filePath
}

export async function exists(targetPath: string): Promise<boolean> {
  try {
    await fsPromises.access(targetPath)
    return true
  } catch {
    return false
  }
}

export function getHomePath(): string {
  return os.homedir()
}

export async function stat(targetPath: string): Promise<FileStat> {
  const stats = await fsPromises.stat(targetPath)
  return {
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    size: stats.size,
    mtime: stats.mtime.toISOString(),
  }
}
