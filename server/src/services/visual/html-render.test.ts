import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { HtmlRenderError, imageRoots, inlineLocalImages, previewHtmlRender, publishHtmlRender } from './html-render.js'
import { setHtmlSnapshotter, type HtmlSnapshotInput } from './html-snapshot.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-html-render-'))
const png = path.join(dir, 'shot.png')
fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
// Named like an image, but not one: must never be read into the page.
const secret = path.join(dir, 'id_rsa.png')
fs.writeFileSync(secret, '-----BEGIN OPENSSH PRIVATE KEY-----')
const svg = path.join(dir, 'logo.svg')
fs.writeFileSync(svg, '<?xml version="1.0"?>\n<!-- c --><svg xmlns="http://www.w3.org/2000/svg"></svg>')

// Another directory, standing for the rest of the disk.
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'operon-html-render-elsewhere-'))
const privatePhoto = path.join(elsewhere, 'photo.png')
fs.writeFileSync(privatePhoto, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
const link = path.join(dir, 'link.png')
fs.symlinkSync(privatePhoto, link)
const roots = [fs.realpathSync(dir)]

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(elsewhere, { recursive: true, force: true })
})

describe('inlineLocalImages', () => {
  it('inlines attribute, JS string and css url() references', async () => {
    const { html, missing } = await inlineLocalImages(
      `<img src="${png}"><script>const a='${svg}'</script><div style="background:url(${png})"></div>`,
      roots,
    )
    expect(missing).toEqual([])
    expect(html).not.toContain(dir)
    expect(html.match(/data:image\/png;base64,/g)).toHaveLength(2)
    expect(html).toContain("'data:image/svg+xml;base64,")
  })

  it('leaves remote and protocol-relative URLs alone', async () => {
    const source = '<img src="https://x.y/a.png"><img src="//cdn.x/a.png">'
    expect(await inlineLocalImages(source, roots)).toEqual({ html: source, missing: [] })
  })

  it('reports a file that is not an image by its bytes', async () => {
    const { html, missing } = await inlineLocalImages(`<img src="${secret}">`, roots)
    expect(missing).toEqual([secret])
    expect(html).not.toContain('PRIVATE KEY')
  })

  it('reads only inside the roots, following symlinks to where they point', async () => {
    const { html, missing } = await inlineLocalImages(`<img src="${privatePhoto}"><img src="${link}">`, roots)
    expect(missing).toEqual([privatePhoto, link])
    expect(html).not.toContain('data:image')
  })

  it('takes the workspace and the temp directory as roots', async () => {
    const found = await imageRoots(dir)
    expect(found).toContain(fs.realpathSync(dir))
    expect(found).toContain(fs.realpathSync(os.tmpdir()))
    expect(await imageRoots('relative/dir')).not.toContain('relative/dir')
  })
})

describe('publishHtmlRender', () => {
  it('rejects vh units', async () => {
    await expect(publishHtmlRender({ html: '<div style="height:100vh">', title: 't', height: 200 })).rejects.toThrow(HtmlRenderError)
  })

  it('rejects missing images instead of publishing a broken page', async () => {
    await expect(publishHtmlRender({ html: `<img src="${dir}/nope.png">`, title: 't', height: 200 })).rejects.toThrow(/nope\.png/)
  })

  it('rejects a missing title', async () => {
    await expect(publishHtmlRender({ html: '<p>x</p>', title: '  ', height: 200 })).rejects.toThrow(/title/)
  })
})

describe('previewHtmlRender', () => {
  afterEach(() => setHtmlSnapshotter(null))

  it('is unavailable without a host that can render', async () => {
    expect(await previewHtmlRender({ html: '<p>x</p>', width: undefined, appearance: undefined })).toBeNull()
  })

  it('renders the themed document and reports images html_render would refuse', async () => {
    const seen: HtmlSnapshotInput[] = []
    setHtmlSnapshotter(async (input) => {
      seen.push(input)
      return { jpeg: Buffer.from('jpg'), contentHeight: 300, capturedHeight: 300, console: [] }
    })
    const preview = await previewHtmlRender({ html: `<img src="${png}"><img src="${dir}/nope.png">`, width: 99999, appearance: 'light' })
    expect(preview).toMatchObject({ width: 1600, contentHeight: 300, missingImages: [`${dir}/nope.png`] })
    expect(seen[0].backgroundColor).toBe('#ffffff')
    expect(seen[0].html).toContain('color-scheme:light')
    expect(seen[0].html).toContain('data:image/png;base64,')
  })

  it('refuses what publishing refuses', async () => {
    setHtmlSnapshotter(async () => ({ jpeg: Buffer.alloc(0), contentHeight: 1, capturedHeight: 1, console: [] }))
    await expect(previewHtmlRender({ html: '<div style="height:50vh">', width: 720, appearance: 'dark' })).rejects.toThrow(/vh/)
  })
})
