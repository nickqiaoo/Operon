import { putAttachment, putDataUrl, parseAttachmentUrl } from './attachment-store.js'

/**
 * Moves inline attachment bytes out of `chat_messages` and into the
 * content-addressed store.
 *
 * Transcripts written before the store existed carry the whole image inside the
 * message JSON, which is what made a conversation with a few screenshots cost
 * tens of MB to load and decode. This rewrites those parts to
 * `/api/attachments/<hash>` once, in the background, on startup.
 *
 * It cannot be a SQL migration: `migrate.ts` only runs `.sql` files, and SQL
 * can't base64-decode a string into a file on disk.
 */

/** kv key holding the last schema version this migration completed. */
const STATE_KEY = 'attachments.inlineMigration'

/** Bumped only if a future change means previously-migrated rows need another pass. */
const MIGRATION_VERSION = 1

interface FilePart {
  type: string
  url?: string
  mediaType?: string
  filename?: string
}

/**
 * The slice of better-sqlite3 this migration needs, as a structural type.
 * Depending on the concrete class would make the tests unrunnable: the native
 * module is built for Electron's ABI and won't load under plain node (see
 * `workflow/resume.test.ts` for the same constraint).
 */
export interface MigrationDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
  transaction<T>(fn: () => T): () => T
}

/**
 * Two inline shapes exist in the wild:
 *
 * - `data:image/png;base64,iVBOR…` — what the composer originally persisted.
 * - `iVBOR…` — bare base64, because `normalizeUiMessagesFileAttachments` strips
 *   the `data:` prefix before handing a turn to the model, and that stripped
 *   message is what gets written back to the transcript.
 *
 * Anything else (`file://`, `http(s)://`, an already-migrated attachment path)
 * is left exactly as-is.
 */
function relocatePart(part: FilePart): FilePart | null {
  const url = part.url
  if (!url || part.type !== 'file') return null
  if (parseAttachmentUrl(url)) return null
  if (url.startsWith('file://') || url.startsWith('http://') || url.startsWith('https://')) {
    return null
  }

  if (url.startsWith('data:')) {
    const stored = putDataUrl(url, part.filename)
    return stored ? { ...part, url: stored.url, mediaType: stored.mediaType } : null
  }

  // Bare base64. Guard on length so a short opaque string — some other URL
  // scheme we haven't seen — isn't misread as image bytes.
  if (!part.mediaType || url.length < 512 || !/^[A-Za-z0-9+/=\s]+$/.test(url)) return null
  try {
    const data = Buffer.from(url, 'base64')
    if (data.byteLength === 0) return null
    const stored = putAttachment(data, { mediaType: part.mediaType, filename: part.filename })
    return { ...part, url: stored.url }
  } catch {
    return null
  }
}

export interface MigrationResult {
  scannedRows: number
  rewrittenRows: number
  relocatedParts: number
  freedBytes: number
}

/**
 * Rewrites every message row still holding inline attachment bytes.
 *
 * Each row is handled independently: one unparseable payload or undecodable
 * image is skipped, never fatal. A row that fails simply keeps its data URL,
 * which still renders — the store is an optimization, not a correctness
 * requirement.
 */
export function migrateInlineAttachments(db: MigrationDb): MigrationResult {
  const result: MigrationResult = {
    scannedRows: 0,
    rewrittenRows: 0,
    relocatedParts: 0,
    freedBytes: 0,
  }

  const rows = db
    .prepare(`SELECT id, payload FROM chat_messages WHERE payload LIKE '%"type":"file"%'`)
    .all() as Array<{ id: number; payload: string }>

  const update = db.prepare('UPDATE chat_messages SET payload = ? WHERE id = ?')

  const run = db.transaction(() => {
    for (const row of rows) {
      result.scannedRows += 1

      let message: { parts?: unknown }
      try {
        message = JSON.parse(row.payload) as { parts?: unknown }
      } catch {
        continue
      }
      if (!Array.isArray(message.parts)) continue

      let changed = false
      const parts = message.parts.map((part) => {
        const relocated = relocatePart(part as FilePart)
        if (!relocated) return part
        changed = true
        result.relocatedParts += 1
        return relocated
      })

      if (!changed) continue

      const nextPayload = JSON.stringify({ ...message, parts })
      update.run(nextPayload, row.id)
      result.rewrittenRows += 1
      result.freedBytes += row.payload.length - nextPayload.length
    }
  })

  run()
  return result
}

/**
 * Runs the migration once per database. Safe to call on every boot — the kv
 * flag short-circuits subsequent runs.
 */
export function migrateInlineAttachmentsOnce(
  db: MigrationDb,
  kv: { get<T>(key: string): T | undefined; set<T>(key: string, value: T): void },
): MigrationResult | null {
  const state = kv.get<{ version?: number }>(STATE_KEY)
  if (state?.version === MIGRATION_VERSION) return null

  const result = migrateInlineAttachments(db)
  kv.set(STATE_KEY, { version: MIGRATION_VERSION, completedAt: new Date().toISOString() })

  if (result.relocatedParts > 0) {
    console.log(
      `[attachments] moved ${result.relocatedParts} inline attachment(s) out of ${result.rewrittenRows} message(s), ` +
        `freeing ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB of transcript`,
    )
  }
  return result
}
