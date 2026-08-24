import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { UIMessage } from 'ai'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-msgutils-'))
process.env.OPERON_DATA_DIR = TMP_DIR

const { putAttachment } = await import('../attachment-store.js')
const { normalizeUiMessagesFileAttachments } = await import('./message-utils.js')

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

const userMessage = (parts: UIMessage['parts']): UIMessage =>
  ({ id: 'm1', role: 'user', parts }) as UIMessage

describe('normalizeUiMessagesFileAttachments — stored attachments', () => {
  it('reads a stored image back as raw base64 for the model', () => {
    const pixels = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    const stored = putAttachment(pixels, { mediaType: 'image/png', filename: 'shot.png' })

    const [message] = normalizeUiMessagesFileAttachments([
      userMessage([{ type: 'file', mediaType: 'image/png', url: stored.url, filename: 'shot.png' }]),
    ])

    const part = message.parts[0] as { type: string; url: string; mediaType: string }
    expect(part.type).toBe('file')
    expect(part.mediaType).toBe('image/png')
    // Raw base64, no `data:` prefix — the AI SDK rejects data: scheme URLs.
    expect(part.url).toBe(pixels.toString('base64'))
  })

  it('degrades to a text note when the blob is missing', () => {
    const [message] = normalizeUiMessagesFileAttachments([
      userMessage([
        {
          type: 'file',
          mediaType: 'image/png',
          url: `/api/attachments/${'c'.repeat(64)}`,
          filename: 'gone.png',
        },
      ]),
    ])

    const part = message.parts[0] as { type: string; text: string }
    expect(part.type).toBe('text')
    expect(part.text).toContain('gone.png')
  })

  it('still strips the prefix off legacy data URLs', () => {
    const [message] = normalizeUiMessagesFileAttachments([
      userMessage([{ type: 'file', mediaType: 'image/jpeg', url: 'data:image/jpeg;base64,QUJD' }]),
    ])

    expect((message.parts[0] as { url: string }).url).toBe('QUJD')
  })

  it('describes a non-image attachment by filename, not by hash', () => {
    const stored = putAttachment(Buffer.from('%PDF-1.4'), {
      mediaType: 'application/pdf',
      filename: 'spec.pdf',
    })

    const [message] = normalizeUiMessagesFileAttachments([
      userMessage([
        { type: 'file', mediaType: 'application/pdf', url: stored.url, filename: 'spec.pdf' },
      ]),
    ])

    const part = message.parts[0] as { type: string; text: string }
    expect(part.type).toBe('text')
    expect(part.text).toContain('spec.pdf')
    expect(part.text).not.toContain(stored.hash)
  })

  it('leaves assistant messages untouched', () => {
    const assistant = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'file', mediaType: 'image/png', url: '/api/attachments/x' }],
    } as unknown as UIMessage

    expect(normalizeUiMessagesFileAttachments([assistant])[0]).toBe(assistant)
  })
})
