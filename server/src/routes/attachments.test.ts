import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-attach-routes-'))
process.env.OPERON_DATA_DIR = TMP_DIR

const { attachmentRoutes } = await import('./attachments.js')

const app = new Hono()
app.route('/api/attachments', attachmentRoutes())

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

const upload = async (bytes: Buffer, type: string, name: string) => {
  const body = new FormData()
  body.append('file', new File([new Uint8Array(bytes)], name, { type }))
  return app.request('/api/attachments', { method: 'POST', body })
}

describe('attachment routes', () => {
  it('uploads then serves the same bytes', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02])

    const postRes = await upload(bytes, 'image/png', 'shot.png')
    expect(postRes.status).toBe(200)
    const stored = (await postRes.json()) as { hash: string; url: string; sizeBytes: number }
    expect(stored.sizeBytes).toBe(bytes.byteLength)

    const getRes = await app.request(stored.url)
    expect(getRes.status).toBe(200)
    expect(getRes.headers.get('Content-Type')).toBe('image/png')
    expect(getRes.headers.get('Cache-Control')).toContain('immutable')
    expect(Buffer.from(await getRes.arrayBuffer()).equals(bytes)).toBe(true)
  })

  it('serves exactly the attachment bytes, not a pooled buffer slice', async () => {
    // Small Buffers share V8's allocation pool, so a naive `.buffer` handoff
    // leaks neighbouring attachments' bytes into the response.
    const first = await upload(Buffer.from('AAAA'), 'text/plain', 'a.txt')
    const second = await upload(Buffer.from('BB'), 'text/plain', 'b.txt')

    const secondUrl = ((await second.json()) as { url: string }).url
    await first.json()

    const res = await app.request(secondUrl)
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('BB')
  })

  it('404s an unknown hash', async () => {
    const res = await app.request(`/api/attachments/${'d'.repeat(64)}`)
    expect(res.status).toBe(404)
  })

  it('404s a malformed hash instead of touching the filesystem', async () => {
    expect((await app.request('/api/attachments/not-a-hash')).status).toBe(404)
  })

  it('rejects a request with no file field', async () => {
    const res = await app.request('/api/attachments', { method: 'POST', body: new FormData() })
    expect(res.status).toBe(400)
  })

  it('rejects a non-multipart body as 400, not 500', async () => {
    const res = await app.request('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"not":"multipart"}',
    })
    expect(res.status).toBe(400)
  })
})
