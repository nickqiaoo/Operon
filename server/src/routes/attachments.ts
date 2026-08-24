import { Hono } from 'hono'
import { getAttachment, putAttachment } from '../services/attachment-store.js'

/** Refuse absurd uploads outright rather than buffering them into memory first. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

export function attachmentRoutes() {
  const router = new Hono()

  // POST /api/attachments - store bytes, return the hash URL to put in a file part
  router.post('/', async (c) => {
    // A body that isn't multipart makes formData() throw. That's a malformed
    // request, not a server fault — answer 400 rather than letting it surface
    // as a 500 from the global error handler.
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      return c.json({ error: 'Expected a multipart/form-data body' }, 400)
    }
    const file = form.get('file')

    if (!(file instanceof File)) {
      return c.json({ error: 'Expected a "file" field' }, 400)
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: `Attachment exceeds ${MAX_UPLOAD_BYTES} bytes` }, 413)
    }

    const data = Buffer.from(await file.arrayBuffer())
    const stored = putAttachment(data, {
      mediaType: file.type || 'application/octet-stream',
      filename: file.name || undefined,
    })

    return c.json(stored)
  })

  // GET /api/attachments/:hash - serve the bytes
  router.get('/:hash', (c) => {
    const stored = getAttachment(c.req.param('hash'))
    if (!stored) return c.json({ error: 'Attachment not found' }, 404)

    // Content-addressed: the bytes at a hash can never change, so let the
    // browser keep them forever. This is what makes reopening a conversation
    // with images cheap — the second load never hits the network.
    return c.body(
      // Hono types the body as ArrayBuffer; Buffer's view may be a slice of a
      // larger pool, so hand over exactly this attachment's bytes.
      stored.data.buffer.slice(
        stored.data.byteOffset,
        stored.data.byteOffset + stored.data.byteLength,
      ) as ArrayBuffer,
      200,
      {
        'Content-Type': stored.meta.mediaType,
        'Content-Length': String(stored.data.byteLength),
        'Cache-Control': 'public, max-age=31536000, immutable',
        ...(stored.meta.filename
          ? { 'Content-Disposition': `inline; filename="${encodeURIComponent(stored.meta.filename)}"` }
          : {}),
      },
    )
  })

  return router
}
