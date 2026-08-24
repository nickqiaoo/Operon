import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The store resolves its directory from OPERON_DATA_DIR at import time, so the
// override has to land before the module is loaded.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-attachments-'))
process.env.OPERON_DATA_DIR = TMP_DIR

const { putAttachment, getAttachment, putDataUrl, parseAttachmentUrl, attachmentUrlFor } =
  await import('./attachment-store.js')

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('attachment-store', () => {
  it('round-trips bytes and metadata', () => {
    const data = Buffer.from('hello world')
    const stored = putAttachment(data, { mediaType: 'text/plain', filename: 'a.txt' })

    expect(stored.url).toBe(`/api/attachments/${stored.hash}`)
    expect(stored.sizeBytes).toBe(data.byteLength)

    const loaded = getAttachment(stored.hash)
    expect(loaded?.data.equals(data)).toBe(true)
    expect(loaded?.meta.mediaType).toBe('text/plain')
    expect(loaded?.meta.filename).toBe('a.txt')
  })

  it('dedupes identical content to one blob', () => {
    const data = Buffer.from('the same screenshot twice')
    const first = putAttachment(data, { mediaType: 'image/png' })
    const second = putAttachment(data, { mediaType: 'image/png' })

    expect(second.hash).toBe(first.hash)
    expect(fs.readdirSync(path.join(TMP_DIR, 'attachments', first.hash.slice(0, 2), first.hash.slice(2, 4))))
      .toEqual([first.hash, `${first.hash}.json`])
  })

  it('stores base64 data URLs', () => {
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const stored = putDataUrl(`data:image/png;base64,${payload.toString('base64')}`, 'shot.png')

    expect(stored).not.toBeNull()
    expect(getAttachment(stored!.hash)?.data.equals(payload)).toBe(true)
    expect(stored!.mediaType).toBe('image/png')
  })

  it('rejects strings that are not data URLs', () => {
    expect(putDataUrl('/api/attachments/deadbeef')).toBeNull()
    expect(putDataUrl('data:image/png;base64,')).toBeNull()
  })

  it('only recognises well-formed attachment URLs', () => {
    const hash = 'a'.repeat(64)
    expect(parseAttachmentUrl(attachmentUrlFor(hash))).toBe(hash)
    expect(parseAttachmentUrl('/api/attachments/short')).toBeNull()
    expect(parseAttachmentUrl('data:image/png;base64,AAAA')).toBeNull()
    // Path traversal must not survive the pattern check.
    expect(parseAttachmentUrl('/api/attachments/../../../etc/passwd')).toBeNull()
  })

  it('refuses to read a hash that is not sha256 hex', () => {
    expect(getAttachment('../../etc/passwd')).toBeUndefined()
    expect(getAttachment('nothex'.repeat(10))).toBeUndefined()
  })

  it('returns undefined for a hash that was never stored', () => {
    expect(getAttachment('b'.repeat(64))).toBeUndefined()
  })
})
