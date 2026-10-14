import fs from 'fs'
import path from 'path'
import type { ProfileFile, ProfileFileName } from '../../../../shared/assistant.js'
import { DEFAULT_PROFILE_FILES } from './defaults.js'
import { ASSISTANT_DIR } from './paths.js'

export const PROFILE_FILE_NAMES: readonly ProfileFileName[] = ['identity', 'soul', 'memory', 'heartbeat']

export function isProfileFileName(value: string): value is ProfileFileName {
  return (PROFILE_FILE_NAMES as readonly string[]).includes(value)
}

/** Who last changed each file. Kept beside the files rather than in the db: it describes them. */
const META_PATH = path.join(ASSISTANT_DIR, '.meta.json')
type Meta = Partial<Record<ProfileFileName, 'assistant' | 'user'>>

function readMeta(): Meta {
  try {
    return JSON.parse(fs.readFileSync(META_PATH, 'utf8')) as Meta
  } catch {
    return {}
  }
}

function writeMeta(name: ProfileFileName, by: 'assistant' | 'user'): void {
  const meta = readMeta()
  meta[name] = by
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2))
}

const filePath = (name: ProfileFileName) => path.join(ASSISTANT_DIR, `${name}.md`)

/**
 * Content each file had the last time WE read or wrote it. The watcher compares
 * against it, so our own writes don't come back as "edited by the user".
 */
const lastKnown = new Map<ProfileFileName, string>()

/** Create the folder and any missing file from its default. Existing files are left alone. */
export function ensureProfileFiles(): void {
  fs.mkdirSync(ASSISTANT_DIR, { recursive: true })
  for (const name of PROFILE_FILE_NAMES) {
    if (!fs.existsSync(filePath(name))) {
      fs.writeFileSync(filePath(name), DEFAULT_PROFILE_FILES[name])
      writeMeta(name, 'assistant')
    }
    // Baseline for the watcher: the write above (or what is already there) is not an edit.
    lastKnown.set(name, fs.readFileSync(filePath(name), 'utf8'))
  }
}

/** @param seen false: leave the watcher's baseline alone, so a change it hasn't reported yet still is. */
export function readProfileFile(name: ProfileFileName, seen = true): ProfileFile {
  const p = filePath(name)
  let content = ''
  let updatedAt = Date.now()
  try {
    content = fs.readFileSync(p, 'utf8')
    updatedAt = fs.statSync(p).mtimeMs
  } catch {
    content = DEFAULT_PROFILE_FILES[name]
  }
  if (seen) lastKnown.set(name, content)
  return { name, content, updatedAt: Math.round(updatedAt), updatedBy: readMeta()[name] ?? 'user' }
}

/**
 * The file's text as it is on disk, without taking it as seen: the watcher still reports a change
 * made since (readProfileFile would swallow it).
 */
export function peekProfileFile(name: ProfileFileName): string {
  try {
    return fs.readFileSync(filePath(name), 'utf8')
  } catch {
    return DEFAULT_PROFILE_FILES[name]
  }
}

export function listProfileFiles(seen = true): ProfileFile[] {
  return PROFILE_FILE_NAMES.map((name) => readProfileFile(name, seen))
}

export function writeProfileFile(name: ProfileFileName, content: string, by: 'assistant' | 'user'): ProfileFile {
  lastKnown.set(name, content)
  fs.mkdirSync(ASSISTANT_DIR, { recursive: true })
  fs.writeFileSync(filePath(name), content)
  writeMeta(name, by)
  return readProfileFile(name)
}

export { parseIdentity } from '../../../../shared/assistant.js'

/** Bullets in `after` that `before` didn't have, as the user would read them: no marker, no date. */
export function addedFacts(before: string, after: string): string[] {
  const had = new Set(before.split('\n').map((l) => l.trim()))
  return after
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+\S/.test(l) && !had.has(l))
    .map((l) => l.replace(/^[-*]\s+/, '').replace(/^\d{4}-\d{2}-\d{2}\s*[:：]\s*/, '').trim())
    .filter(Boolean)
}

/**
 * Report edits made outside the app's own writes — the agents' file tools, an editor — credited to
 * whoever `by` says is likely at work. Debounced per file: editors often write in several steps.
 */
export function watchProfileFiles(onChange: (file: ProfileFile) => void, by: () => 'assistant' | 'user' = () => 'user'): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let watcher: fs.FSWatcher
  try {
    watcher = fs.watch(ASSISTANT_DIR, (_event, filename) => {
      const base = filename ? String(filename).replace(/\.md$/, '') : ''
      if (!isProfileFileName(base)) return
      clearTimeout(timers.get(base))
      timers.set(
        base,
        setTimeout(() => {
          let content: string
          try {
            content = fs.readFileSync(filePath(base), 'utf8')
          } catch {
            return
          }
          if (content === lastKnown.get(base)) return
          lastKnown.set(base, content)
          writeMeta(base, by())
          onChange(readProfileFile(base))
        }, 150),
      )
    })
  } catch (error) {
    console.warn('[assistant] cannot watch profile files:', error)
    return () => {}
  }
  return () => {
    watcher.close()
    for (const t of timers.values()) clearTimeout(t)
  }
}
