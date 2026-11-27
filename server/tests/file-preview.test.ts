import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { fsRoutes } from '../src/routes/fs.js'

const app = fsRoutes()
let dir: string
let asset: string
const data = Buffer.from([0, 1, 2, 3, 4, 5])
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'preview-'))
  asset = join(dir, 'asset.mp4')
  await writeFile(asset, data)
})
afterAll(() => rm(dir, { recursive: true, force: true }))

it.each([
  ['bytes=1-3', 'bytes 1-3/6', [1, 2, 3]],
  ['bytes=-2', 'bytes 4-5/6', [4, 5]],
  ['bytes=4-', 'bytes 4-5/6', [4, 5]],
])('serves a seek request %s', async (range, contentRange, expected) => {
  const response = await app.request('/file?path=' + encodeURIComponent(asset), { headers: { Range: String(range) } })
  expect(response.status).toBe(206)
  expect(response.headers.get('content-range')).toBe(contentRange)
  expect(response.headers.get('content-type')).toBe('video/mp4')
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(expected)
})
it('returns 416 for a seek beyond EOF', async () => {
  const response = await app.request('/file?path=' + encodeURIComponent(asset), { headers: { Range: 'bytes=8-' } })
  expect(response.status).toBe(416)
})
it('detects binary text previews and preserves extensionless text', async () => {
  const preview = (path: string) => app.request('/read-file', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, preview: true }),
  })
  expect((await preview(asset)).status).toBe(415)
  const path = join(dir, 'README')
  await writeFile(path, '中文 README')
  expect(await (await preview(path)).json()).toEqual({ content: '中文 README' })
})
