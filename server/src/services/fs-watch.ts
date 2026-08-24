import chokidar, { type FSWatcher } from 'chokidar'
import { randomUUID } from 'crypto'

export interface WatchEvent {
  id: string
  event: string
  path: string
  error?: string
}

interface WatchEntry {
  id: string
  key: string
  targetPath: string
  depth?: number
  ignored: string[]
  watcher: FSWatcher
  refCount: number
  lastUsedAt: number
}

type WatchOptions = { ignored?: string | string[]; depth?: number }

const DEFAULT_IGNORED_PATTERNS = [
  '**/.git/**',
  '**/node_modules/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/tmp/**',
  '**/temp/**',
  '**/out/**',
]

const WATCHER_LIMIT = parsePositiveInt(process.env.FS_WATCH_MAX_ACTIVE, 6)
const ORPHAN_CLEANUP_DELAY_MS = parsePositiveInt(
  process.env.FS_WATCH_ORPHAN_CLEANUP_DELAY_MS,
  10000
)

const watchers = new Map<string, WatchEntry>()
const watcherIdsByKey = new Map<string, string>()
const idleWatchers: WatchEntry[] = []
const eventListeners = new Set<(event: WatchEvent) => void>()
let orphanCleanupTimer: NodeJS.Timeout | null = null

export function addEventListener(listener: (event: WatchEvent) => void): () => void {
  cancelOrphanCleanup()
  eventListeners.add(listener)
  return () => {
    eventListeners.delete(listener)
    if (eventListeners.size === 0) {
      scheduleOrphanCleanup()
    }
  }
}

function emit(event: WatchEvent) {
  for (const listener of eventListeners) {
    listener(event)
  }
}

export function createWatch(
  targetPath: string,
  options?: WatchOptions
): string {
  cancelOrphanCleanup()
  const depth = normalizeDepth(options?.depth)
  const ignored = normalizeIgnored(options?.ignored)
  const key = buildWatchKey(targetPath, depth, ignored)
  const existingId = watcherIdsByKey.get(key)
  if (existingId) {
    const entry = watchers.get(existingId)
    if (entry) {
      entry.refCount += 1
      entry.lastUsedAt = Date.now()
      return existingId
    }
    watcherIdsByKey.delete(key)
  }

  ensureWatcherCapacity()

  const id = randomUUID()
  const watcher = chokidar.watch(targetPath, {
    ignoreInitial: true,
    persistent: true,
    depth,
    ignored,
  })
  const now = Date.now()

  watcher.on('all', (eventName, changedPath) => {
    emit({ id, event: eventName, path: changedPath })
  })

  watcher.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    emit({ id, event: 'error', path: targetPath, error: message })
    if (isWatchLimitError(message)) {
      const entry = watchers.get(id)
      if (entry) {
        closeWatch(entry).catch(() => {})
      }
    }
  })

  watchers.set(id, {
    id,
    key,
    targetPath,
    depth,
    ignored,
    watcher,
    refCount: 1,
    lastUsedAt: now,
  })
  watcherIdsByKey.set(key, id)
  if (eventListeners.size === 0) {
    scheduleOrphanCleanup()
  }
  return id
}

export function removeWatch(watchId: string): boolean {
  const entry = watchers.get(watchId)
  if (!entry) return false
  entry.refCount -= 1
  entry.lastUsedAt = Date.now()
  if (entry.refCount > 0) return true
  // Remove from active maps and silence the watcher by stripping listeners.
  // Don't call close() — it synchronously tears down native fs watchers and
  // blocks the event loop for seconds on large repos. Instead, park the
  // watcher in an idle pool. It will be closed only when capacity is needed.
  watcherIdsByKey.delete(entry.key)
  watchers.delete(entry.id)
  entry.watcher.removeAllListeners()
  idleWatchers.push(entry)
  if (eventListeners.size === 0) {
    scheduleOrphanCleanup()
  }
  return true
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback
  }
  return Math.floor(parsed)
}

function normalizeDepth(depth: number | undefined): number | undefined {
  if (typeof depth !== 'number' || !Number.isFinite(depth) || depth < 0) {
    return undefined
  }
  return Math.floor(depth)
}

function normalizeIgnored(ignored: string | string[] | undefined): string[] {
  const allPatterns = [...DEFAULT_IGNORED_PATTERNS]
  if (typeof ignored === 'string') {
    allPatterns.push(ignored)
  } else if (Array.isArray(ignored)) {
    allPatterns.push(...ignored)
  }

  const deduped = new Set<string>()
  for (const pattern of allPatterns) {
    const trimmed = pattern.trim()
    if (trimmed) {
      deduped.add(trimmed)
    }
  }
  return Array.from(deduped).sort()
}

function buildWatchKey(
  targetPath: string,
  depth: number | undefined,
  ignored: string[]
): string {
  const depthValue = depth ?? -1
  return `${targetPath}::${depthValue}::${ignored.join('|')}`
}

function ensureWatcherCapacity() {
  while (watchers.size >= WATCHER_LIMIT) {
    const oldest = findOldestWatch()
    if (!oldest) return
    watcherIdsByKey.delete(oldest.key)
    watchers.delete(oldest.id)
    oldest.watcher.removeAllListeners()
    oldest.watcher.close().catch(() => {})
    emit({
      id: oldest.id,
      event: 'error',
      path: oldest.targetPath,
      error: `Watcher limit reached (${WATCHER_LIMIT}). Recycled an old watcher.`,
    })
  }
}

function findOldestWatch(): WatchEntry | null {
  let oldest: WatchEntry | null = null
  for (const entry of watchers.values()) {
    if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) {
      oldest = entry
    }
  }
  return oldest
}

async function closeWatch(entry: WatchEntry): Promise<void> {
  watcherIdsByKey.delete(entry.key)
  watchers.delete(entry.id)
  try {
    await entry.watcher.close()
  } catch {}
}

function cancelOrphanCleanup() {
  if (!orphanCleanupTimer) return
  clearTimeout(orphanCleanupTimer)
  orphanCleanupTimer = null
}

function scheduleOrphanCleanup() {
  cancelOrphanCleanup()
  if ((watchers.size === 0 && idleWatchers.length === 0) || eventListeners.size > 0) return

  orphanCleanupTimer = setTimeout(() => {
    orphanCleanupTimer = null
    if (eventListeners.size > 0) return
    // Clean up idle watchers
    while (idleWatchers.length > 0) {
      const idle = idleWatchers.shift()!
      idle.watcher.close().catch(() => {})
    }
    // Clean up orphaned active watchers
    if (watchers.size === 0) return
    const staleWatchers = Array.from(watchers.values())
    staleWatchers.forEach((entry) => {
      watcherIdsByKey.delete(entry.key)
      watchers.delete(entry.id)
      entry.watcher.removeAllListeners()
      entry.watcher.close().catch(() => {})
    })
  }, ORPHAN_CLEANUP_DELAY_MS)
}

function isWatchLimitError(message: string): boolean {
  return /EMFILE|ENOSPC|too many open files|watch/i.test(message)
}
