import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AssistantWorkspaceFile } from '../../../../shared/assistant.js'
import { ASSISTANT_DIR, ASSISTANT_OUTPUTS, ASSISTANT_WORKSPACE } from './paths.js'

/** Deep enough for "a folder per trip". */
const MAX_DEPTH = 4
const MAX_FILES = 500

/** What the assistant made for the user (its outputs folder), newest first. */
export async function listOutputFiles(root = ASSISTANT_OUTPUTS): Promise<AssistantWorkspaceFile[]> {
  const files: AssistantWorkspaceFile[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fs.promises.stat(full).catch(() => null)
      if (!stat) continue
      files.push({
        path: full,
        relativePath: path.relative(root, full).split(path.sep).join('/'),
        size: stat.size,
        updatedAt: Math.round(stat.mtimeMs),
      })
    }
  }
  await walk(root, 1)
  return files.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * The file a path in the assistant's reply means, or null when there is none. Relative paths are
 * read the way the assistant writes them: from its working directory (the workspace), or from its
 * home (`workspace/…`, as memory.md cites them).
 */
export async function resolveAssistantPath(raw: string): Promise<string | null> {
  const value = raw.trim()
  if (!value) return null
  const expanded = value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value
  const candidates = path.isAbsolute(expanded)
    ? [expanded]
    : [path.join(ASSISTANT_WORKSPACE, expanded), path.join(ASSISTANT_DIR, expanded)]
  for (const candidate of candidates) {
    const stat = await fs.promises.stat(candidate).catch(() => null)
    if (stat?.isFile()) return path.normalize(candidate)
  }
  return null
}

/** The folder of the assistant's that `file` is in — the workspace before its home — for showing it relative. */
export function assistantRootOf(file: string): string | null {
  for (const root of [ASSISTANT_WORKSPACE, ASSISTANT_DIR]) {
    if (file.startsWith(root + path.sep)) return root
  }
  return null
}
