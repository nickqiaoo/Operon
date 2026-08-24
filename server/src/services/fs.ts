import fsPromises from 'fs/promises'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
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
