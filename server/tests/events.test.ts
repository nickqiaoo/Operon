import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from './helpers/make-app.js'

type Frame = { ch: string; data: { type?: string; t?: string } }

async function readFrames(response: Response, until: (frames: Frame[]) => boolean): Promise<Frame[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const frames: Frame[] = []
  let buffer = ''
  try {
    while (!until(frames)) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)) as Frame)
    }
  } finally {
    await reader.cancel()
  }
  return frames
}

describe('GET /api/events', () => {
  let ctx: TestApp
  beforeEach(async () => { ctx = await makeTestApp() })
  afterEach(() => ctx.cleanup())

  it('carries every requested channel on one stream, each tagged with its name', async () => {
    const channels = ['live-status', 'workflow', 'external-agents', 'tasks', 'inbox']
    const response = await ctx.request(`/api/events?ch=${channels.join(',')}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    // Each feed opens with its snapshot; the empty task list sends none.
    const opening = ['live-status', 'workflow', 'external-agents', 'inbox']
    const frames = await readFrames(response, (seen) => opening.every((ch) => seen.some((f) => f.ch === ch)))
    expect(frames.find((f) => f.ch === 'live-status')?.data.type).toBe('sync')
    expect(frames.find((f) => f.ch === 'workflow')?.data.t).toBe('sync')
    expect(frames.find((f) => f.ch === 'external-agents')?.data.type).toBe('sync')
    expect(frames.find((f) => f.ch === 'inbox')?.data.type).toBe('counts')
  })

  it('sends only the channels asked for', async () => {
    const response = await ctx.request('/api/events?ch=inbox,external-agents')
    const frames = await readFrames(response, (seen) => seen.length >= 2)
    expect(new Set(frames.map((f) => f.ch))).toEqual(new Set(['inbox', 'external-agents']))
  })

  it('rejects an unknown or empty channel list', async () => {
    expect((await ctx.request('/api/events?ch=inbox,nope')).status).toBe(400)
    expect((await ctx.request('/api/events')).status).toBe(400)
  })
})
