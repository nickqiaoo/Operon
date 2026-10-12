import fs from 'fs'
import path from 'path'
import type { ProfileFile, ProfileFileName } from '../../../../shared/assistant.js'
import { DEFAULT_PROFILE_FILES } from './defaults.js'
import { ASSISTANT_DIR } from './paths.js'

export const PROFILE_FILE_NAMES: readonly ProfileFileName[] = ['identity', 'soul', 'memory']

export function isProfileFileName(value: string): value is ProfileFileName {
  return (PROFILE_FILE_NAMES as readonly string[]).includes(value)
}

/** Who last changed each file. Kept beside the files rather than in the db: it describes them. */
const META_PATH = path.join(ASSISTANT_DIR, '.meta.json')
type Meta = Partial<Record<ProfileFileName | 'heartbeat', 'assistant' | 'user'>>

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
  migrateHeartbeatFile()
  for (const name of PROFILE_FILE_NAMES) {
    if (!fs.existsSync(filePath(name))) {
      fs.writeFileSync(filePath(name), DEFAULT_PROFILE_FILES[name])
      writeMeta(name, 'assistant')
    }
    // Baseline for the watcher: the write above (or what is already there) is not an edit.
    lastKnown.set(name, fs.readFileSync(filePath(name), 'utf8'))
  }
}

/** The one line the old heartbeat.md template came with; not something the user asked for. */
const OLD_HEARTBEAT_DEFAULT = '- Look at "In progress" in memory.md; if something is due for a follow-up, ask about it.'

/**
 * heartbeat.md is gone: what to watch for now lives under "In progress" in memory.md, which the
 * heartbeat already reads. Move the user's own lines there once, then drop the file.
 */
function migrateHeartbeatFile(): void {
  const old = path.join(ASSISTANT_DIR, 'heartbeat.md')
  let content: string
  try {
    content = fs.readFileSync(old, 'utf8')
  } catch {
    return
  }
  const items = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+\S/.test(l) && l !== OLD_HEARTBEAT_DEFAULT)
  if (items.length) {
    let memory: string
    try {
      memory = fs.readFileSync(filePath('memory'), 'utf8')
    } catch {
      memory = DEFAULT_PROFILE_FILES.memory
    }
    fs.writeFileSync(filePath('memory'), addToInProgress(memory, items))
    writeMeta('memory', 'assistant')
  }
  fs.rmSync(old, { force: true })
  const meta = readMeta()
  delete meta.heartbeat
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2))
}

/** memory.md with `items` added at the end of its "In progress" section (created when missing). */
export function addToInProgress(memory: string, items: readonly string[]): string {
  const lines = memory.replace(/\n+$/, '').split('\n')
  const start = lines.findIndex((l) => /^#+\s*in progress\s*$/i.test(l.trim()))
  if (start === -1) return `${lines.join('\n')}\n\n# In progress\n${items.join('\n')}\n`
  let end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l))
  if (end === -1) end = lines.length
  // After the section's last non-blank line, so a blank line before the next heading stays.
  while (end > start + 1 && lines[end - 1]!.trim() === '') end--
  lines.splice(end, 0, ...items)
  return `${lines.join('\n')}\n`
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
