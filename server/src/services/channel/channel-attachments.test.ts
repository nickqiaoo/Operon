import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-channel-attach-'))
process.env.OPERON_DATA_DIR = TMP_DIR

const { localImagePath, sanitizeChannelAttachments, storeLocalImages, MAX_MESSAGE_IMAGES } = await import('./channel-attachments.js')
const { formatChannelMessage } = await import('../agent-comm/channel-message-format.js')

afterAll(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }))

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

function writeImage(name: string, data = PNG): string {
  const p = path.join(TMP_DIR, name)
  fs.writeFileSync(p, data)
  return p
}

describe('channel message images', () => {
  it("copies an agent's local image into the store and hands back a readable path with an extension", () => {
    const [stored] = storeLocalImages([writeImage('shot.png')])
    expect(stored).toMatchObject({ mediaType: 'image/png', filename: 'shot.png' })
    expect(stored.url).toMatch(/^\/api\/attachments\/[a-f0-9]{64}$/)

    const local = localImagePath(stored)
    expect(local).toMatch(/\.png$/)
    expect(fs.readFileSync(local!)).toEqual(PNG)
    // Made once: asking again returns the same file.
    expect(localImagePath(stored)).toBe(local)
  })

  it('refuses relative paths, non-images, missing files and too many images', () => {
    expect(() => storeLocalImages(['shot.png'])).toThrow(/absolute/)
    expect(() => storeLocalImages([writeImage('notes.txt', Buffer.from('hi'))])).toThrow(/Not an image/)
    expect(() => storeLocalImages([path.join(TMP_DIR, 'gone.png')])).toThrow(/not found/)
    const many = Array.from({ length: MAX_MESSAGE_IMAGES + 1 }, () => writeImage('a.png'))
    expect(() => storeLocalImages(many)).toThrow(/At most/)
  })

  it('keeps only stored images from what a client sends', () => {
    const [stored] = storeLocalImages([writeImage('ok.png')])
    expect(sanitizeChannelAttachments([
      stored,
      { url: `/api/attachments/${'0'.repeat(64)}`, mediaType: 'image/png' },
      { url: 'https://example.com/x.png', mediaType: 'image/png' },
      { url: stored.url, mediaType: 'application/pdf' },
      'junk',
    ])).toEqual([stored])
  })

  it('names each image by its local path in the text an agent reads', () => {
    const [stored] = storeLocalImages([writeImage('chart.png')])
    const line = formatChannelMessage({
      id: 9, channelId: 1, threadRootId: null, senderType: 'human', senderId: null, senderName: 'you',
      content: 'what is this?', replyCount: 0, lastReplyAt: null, senderBindingId: null, attachments: [stored], createdAt: 0,
    }, 'general')
    expect(line).toContain('] what is this?\n[image: ')
    expect(line).toContain(localImagePath(stored)!)
  })
})
