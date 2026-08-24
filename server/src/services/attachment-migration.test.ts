import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MigrationDb } from './attachment-migration.js'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-attach-mig-'))
process.env.OPERON_DATA_DIR = TMP_DIR

const { migrateInlineAttachments, migrateInlineAttachmentsOnce } = await import(
  './attachment-migration.js'
)
const { getAttachment, parseAttachmentUrl } = await import('./attachment-store.js')

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

/**
 * In-memory stand-in for the two statements the migration issues. better-sqlite3
 * is compiled for Electron's ABI and can't load under plain node, and the logic
 * under test is JSON rewriting rather than SQL — so a fake keeps this hermetic.
 */
function fakeDb() {
  const rows: Array<{ id: number; payload: string }> = []
  let nextId = 1

  const db: MigrationDb = {
    prepare: (sql: string) => ({
      all: () => {
        if (!sql.includes('SELECT')) throw new Error(`unexpected all() on: ${sql}`)
        return rows.filter((r) => r.payload.includes('"type":"file"')).map((r) => ({ ...r }))
      },
      run: (...params: unknown[]) => {
        if (!sql.startsWith('UPDATE')) throw new Error(`unexpected run() on: ${sql}`)
        const [payload, id] = params as [string, number]
        const row = rows.find((r) => r.id === id)
        if (row) row.payload = payload
        return undefined
      },
    }),
    // The real one wraps in a SQLite transaction; ordering is all that matters here.
    transaction: <T,>(fn: () => T) => fn,
  }

  return {
    db,
    insertRaw: (payload: string) => {
      const id = nextId++
      rows.push({ id, payload })
      return id
    },
    payloadOf: (id: number) => rows.find((r) => r.id === id)!.payload,
    allPayloads: () => rows.map((r) => r.payload),
  }
}

let store: ReturnType<typeof fakeDb>
let db: MigrationDb

beforeEach(() => {
  store = fakeDb()
  db = store.db
})

const insert = (parts: unknown[]) =>
  store.insertRaw(JSON.stringify({ id: 'm', role: 'user', parts }))

const partsOf = (id: number) =>
  (JSON.parse(store.payloadOf(id)) as { parts: Array<Record<string, string>> }).parts

// Long enough to clear the migration's bare-base64 length guard.
const IMAGE_BYTES = Buffer.alloc(1024, 0x7f)
const IMAGE_B64 = IMAGE_BYTES.toString('base64')

describe('migrateInlineAttachments', () => {
  it('relocates a data: URL and preserves the bytes', () => {
    const id = insert([
      { type: 'file', mediaType: 'image/png', url: `data:image/png;base64,${IMAGE_B64}`, filename: 'a.png' },
    ])

    const result = migrateInlineAttachments(db)
    expect(result.relocatedParts).toBe(1)
    expect(result.freedBytes).toBeGreaterThan(0)

    const url = partsOf(id)[0].url
    const hash = parseAttachmentUrl(url)
    expect(hash).not.toBeNull()
    expect(getAttachment(hash!)?.data.equals(IMAGE_BYTES)).toBe(true)
  })

  it('relocates bare base64, the shape the model path writes back', () => {
    const id = insert([{ type: 'file', mediaType: 'image/jpeg', url: IMAGE_B64, filename: 'b.jpg' }])

    expect(migrateInlineAttachments(db).relocatedParts).toBe(1)

    const hash = parseAttachmentUrl(partsOf(id)[0].url)
    expect(getAttachment(hash!)?.data.equals(IMAGE_BYTES)).toBe(true)
    expect(getAttachment(hash!)?.meta.mediaType).toBe('image/jpeg')
  })

  it('leaves file://, http:// and already-migrated parts alone', () => {
    const id = insert([
      { type: 'file', mediaType: 'image/png', url: 'file:///tmp/x.png' },
      { type: 'file', mediaType: 'image/png', url: 'https://example.com/x.png' },
      { type: 'file', mediaType: 'image/png', url: `/api/attachments/${'a'.repeat(64)}` },
      { type: 'text', text: 'hello' },
    ])

    expect(migrateInlineAttachments(db).relocatedParts).toBe(0)
    expect(partsOf(id).map((p) => p.url ?? p.text)).toEqual([
      'file:///tmp/x.png',
      'https://example.com/x.png',
      `/api/attachments/${'a'.repeat(64)}`,
      'hello',
    ])
  })

  it('does not mistake a short opaque string for image bytes', () => {
    const id = insert([{ type: 'file', mediaType: 'image/png', url: 'AAAA' }])
    expect(migrateInlineAttachments(db).relocatedParts).toBe(0)
    expect(partsOf(id)[0].url).toBe('AAAA')
  })

  it('skips an unparseable row without failing the run', () => {
    store.insertRaw('{"type":"file" not json')
    const id = insert([{ type: 'file', mediaType: 'image/png', url: IMAGE_B64 }])

    const result = migrateInlineAttachments(db)
    expect(result.relocatedParts).toBe(1)
    expect(parseAttachmentUrl(partsOf(id)[0].url)).not.toBeNull()
  })

  it('is idempotent — a second pass relocates nothing', () => {
    insert([{ type: 'file', mediaType: 'image/png', url: `data:image/png;base64,${IMAGE_B64}` }])

    expect(migrateInlineAttachments(db).relocatedParts).toBe(1)
    expect(migrateInlineAttachments(db).relocatedParts).toBe(0)
  })

  it('dedupes the same image sent across several messages', () => {
    insert([{ type: 'file', mediaType: 'image/png', url: IMAGE_B64 }])
    insert([{ type: 'file', mediaType: 'image/png', url: IMAGE_B64 }])

    expect(migrateInlineAttachments(db).relocatedParts).toBe(2)

    const hashes = new Set(
      store
        .allPayloads()
        .map((p) => parseAttachmentUrl((JSON.parse(p) as { parts: Array<{ url: string }> }).parts[0].url)),
    )
    expect(hashes.size).toBe(1)
  })
})

describe('migrateInlineAttachmentsOnce', () => {
  it('runs once and short-circuits afterwards', () => {
    insert([{ type: 'file', mediaType: 'image/png', url: IMAGE_B64 }])

    const store = new Map<string, unknown>()
    const kv = {
      get: <T,>(key: string) => store.get(key) as T | undefined,
      set: <T,>(key: string, value: T) => void store.set(key, value),
    }

    expect(migrateInlineAttachmentsOnce(db, kv)?.relocatedParts).toBe(1)
    expect(migrateInlineAttachmentsOnce(db, kv)).toBeNull()
  })
})
