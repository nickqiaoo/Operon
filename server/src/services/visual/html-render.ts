import fs from 'node:fs/promises'
import path from 'node:path'
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_DEFAULT_THEMES,
  HTML_RENDER_MAX_PAGE_BYTES,
  HTML_RENDER_PREVIEW_MAX_WIDTH,
  HTML_RENDER_PREVIEW_MIN_WIDTH,
  buildHtmlRenderDocument,
  HTML_RENDER_MAX_SOURCE_BYTES,
  HTML_RENDER_MAX_TITLE_LENGTH,
  clampHtmlRenderHeight,
  type HtmlRenderRef,
} from '@shared/html-render'
import { putAttachment } from '../attachment-store.js'
import { getHtmlSnapshotter, type HtmlSnapshot } from './html-snapshot.js'

/** Publishing a visual reply: validate the agent's page, inline its local images, store it. */

const MAX_IMAGE_BYTES = 4 * 1024 * 1024

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
}
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join('|')

/** An absolute path to an image, quoted (attribute or JS string) or inside CSS `url()`. */
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(/(?!/)(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(/(?!/)[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  'gi',
)

// The lookbehind skips base64 runs, such as an inlined image that happens to contain "1vh".
const VIEWPORT_HEIGHT_UNIT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/i

export class HtmlRenderError extends Error {}

/** Checks the bytes, not the name, so a renamed file or a symlink cannot inline a secret. */
function isImageBytes(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 12).toString('latin1')
  if (
    head.startsWith('\x89PNG') ||
    head.startsWith('\xff\xd8\xff') ||
    head.startsWith('GIF8') ||
    head.startsWith('\0\0\x01\0') ||
    (head.startsWith('BM') && head.slice(6, 10) === '\0\0\0\0') ||
    (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  ) {
    return true
  }
  // SVG: skip an XML declaration, comments and a doctype, then require the root element.
  const text = bytes.subarray(0, 4096).toString('utf8')
  const rest = text.replace(/^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype[^>[]*(?:\[[\s\S]*?\])?\s*>)*/i, '')
  return /^<svg[\s/>]/.test(rest)
}

async function readImage(file: string): Promise<Buffer | null> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return null
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new HtmlRenderError(`${file} is ${(stat.size / 1024 / 1024).toFixed(1)} MB; images are limited to ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`)
    }
    const bytes = await fs.readFile(file)
    return isImageBytes(bytes) ? bytes : null
  } catch (error) {
    if (error instanceof HtmlRenderError) throw error
    return null
  }
}

/** Replaces each local image path with a data URL; returns the paths that were not readable images. */
export async function inlineLocalImages(html: string): Promise<{ html: string; missing: string[] }> {
  const references = [...html.matchAll(LOCAL_IMAGE_PATTERN)].map((match) => {
    const value = match[2] ?? match[3]
    const start = (match.index ?? 0) + match[0].indexOf(value)
    return { start, end: start + value.length, path: value }
  })
  const paths = [...new Set(references.map((reference) => reference.path))]
  const dataUrls = new Map<string, string>()
  let total = Buffer.byteLength(html)
  for (const file of paths) {
    const bytes = await readImage(path.normalize(file))
    if (!bytes) continue
    const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
    const dataUrl = `data:${IMAGE_MIME_TYPES[ext] ?? 'application/octet-stream'};base64,${bytes.toString('base64')}`
    total += dataUrl.length
    if (total > HTML_RENDER_MAX_PAGE_BYTES) {
      throw new HtmlRenderError(`With its images inlined the page exceeds ${HTML_RENDER_MAX_PAGE_BYTES / 1024 / 1024} MB. Use smaller images.`)
    }
    dataUrls.set(file, dataUrl)
  }
  let out = ''
  let cursor = 0
  for (const reference of references) {
    const dataUrl = dataUrls.get(reference.path)
    if (!dataUrl) continue
    out += html.slice(cursor, reference.start) + dataUrl
    cursor = reference.end
  }
  out += html.slice(cursor)
  return { html: out, missing: paths.filter((file) => !dataUrls.has(file)) }
}

/** What publishing and previewing both refuse: a missing or oversized page, and vh units. */
function checkSource(html: unknown): string {
  if (typeof html !== 'string' || !html.trim()) throw new HtmlRenderError('html is required: a complete, self-contained HTML document.')
  if (Buffer.byteLength(html) > HTML_RENDER_MAX_SOURCE_BYTES) {
    throw new HtmlRenderError(`html is limited to ${HTML_RENDER_MAX_SOURCE_BYTES / 1000} KB. Reference local images by path instead of embedding them.`)
  }
  // A page sized in vh grows with its frame, and the frame grows with the page.
  const vh = VIEWPORT_HEIGHT_UNIT.exec(html)
  if (vh) throw new HtmlRenderError(`The page uses "${vh[0]}". vh units are not allowed: give elements fixed pixel heights and let content set the page height.`)
  return html
}

export async function publishHtmlRender(input: { html: unknown; title: unknown; height: unknown }): Promise<HtmlRenderRef> {
  const html = checkSource(input.html)
  const { title, height } = input
  if (typeof title !== 'string' || !title.trim()) throw new HtmlRenderError('title is required.')
  if (typeof height !== 'number' || !Number.isFinite(height)) throw new HtmlRenderError('height is required, in CSS pixels.')

  const inlined = await inlineLocalImages(html)
  if (inlined.missing.length > 0) {
    throw new HtmlRenderError(`These image paths are not readable image files: ${inlined.missing.join(', ')}`)
  }
  const name = title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH)
  const stored = putAttachment(Buffer.from(inlined.html), {
    mediaType: 'text/html',
    filename: `${name.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').trim().slice(0, 120) || 'Page'}.html`,
  })
  return { url: stored.url, title: name, height: clampHtmlRenderHeight(height) }
}

export interface HtmlRenderPreview extends Omit<HtmlSnapshot, 'jpeg'> {
  width: number
  jpeg: Buffer
  /** Local image paths that would make html_render fail. */
  missingImages: string[]
}

/** Renders the page the way the chat will show it, without publishing. Null when this host cannot render. */
export async function previewHtmlRender(input: { html: unknown; width: unknown; appearance: unknown }): Promise<HtmlRenderPreview | null> {
  const snapshot = getHtmlSnapshotter()
  if (!snapshot) return null
  const html = checkSource(input.html)
  const width = typeof input.width === 'number' && Number.isFinite(input.width)
    ? Math.min(HTML_RENDER_PREVIEW_MAX_WIDTH, Math.max(HTML_RENDER_PREVIEW_MIN_WIDTH, Math.round(input.width)))
    : HTML_RENDER_COLUMN_WIDTH
  const theme = HTML_RENDER_DEFAULT_THEMES[input.appearance === 'light' ? 'light' : 'dark']
  const inlined = await inlineLocalImages(html)
  const shot = await snapshot({
    html: buildHtmlRenderDocument(inlined.html, theme),
    width,
    backgroundColor: theme.variables['--background'],
  })
  return { ...shot, width, missingImages: inlined.missing }
}
