import { randomUUID } from 'node:crypto'
import { BrowserWindow, session as electronSession, type Session } from 'electron'
import { setHtmlSnapshotter, type HtmlSnapshot, type HtmlSnapshotInput } from '../server/src/services/visual/html-snapshot.js'

/**
 * html_preview's renderer: an offscreen window per preview, destroyed after the
 * capture. The page is the agent's, scripts and all, so it gets what the chat
 * iframe gets and no more:
 *
 *  - its own in-memory session, so it shares no cookies or storage with the app;
 *  - served with `CSP: sandbox allow-scripts`, an opaque origin like the iframe;
 *  - no navigation, popups, downloads or permission prompts.
 *
 * It loads through a scheme on that session rather than a data: URL, which
 * Chromium caps at 2 MB, below a page with inlined images.
 */

const SCHEME = 'operon-preview'
/** No `persist:` prefix: the session lives in memory only. */
const PARTITION = 'operon-html-preview'
/** Tall enough to see a long page, short enough to stay a reasonable image. */
const MAX_CAPTURE_HEIGHT = 4000
const LOAD_TIMEOUT_MS = 15_000
/** Fonts, CDN charts and first animations get this long after load. */
const SETTLE_MS = 400
const MAX_CONSOLE_MESSAGES = 50
const MAX_CONCURRENT = 2

const pages = new Map<string, string>()
let previewSession: Session | null = null

function getPreviewSession(): Session {
  if (previewSession) return previewSession
  const ses = electronSession.fromPartition(PARTITION)
  ses.protocol.handle(SCHEME, (request) => {
    const html = pages.get(new URL(request.url).hostname)
    if (html === undefined) return new Response('Not found', { status: 404 })
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': 'sandbox allow-scripts' },
    })
  })
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  ses.on('will-download', (event) => event.preventDefault())
  previewSession = ses
  return ses
}

let running = 0
const waiting: Array<() => void> = []

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++
    return
  }
  await new Promise<void>((resolve) => waiting.push(resolve))
}

function release(): void {
  const next = waiting.shift()
  if (next) next()
  else running--
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

const CONTENT_HEIGHT = `(() => {
  const r = document.documentElement
  return Math.ceil(r.scrollHeight > r.clientHeight ? r.scrollHeight : r.getBoundingClientRect().height)
})()`

async function snapshot(input: HtmlSnapshotInput): Promise<HtmlSnapshot> {
  await acquire()
  const id = randomUUID()
  pages.set(id, input.html)
  const win = new BrowserWindow({
    show: false,
    width: input.width,
    // Full height from the start: an offscreen view keeps the size it was created
    // with, so the page is laid out at the capture height and cropped to itself.
    height: MAX_CAPTURE_HEIGHT,
    useContentSize: true,
    backgroundColor: input.backgroundColor,
    webPreferences: {
      offscreen: { deviceScaleFactor: 1 },
      session: getPreviewSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  const consoleMessages: HtmlSnapshot['console'] = []
  const note = (level: HtmlSnapshot['console'][number]['level'], text: string) => {
    if (consoleMessages.length < MAX_CONSOLE_MESSAGES) consoleMessages.push({ level, text: text.slice(0, 1000) })
  }
  const contents = win.webContents
  let blockedNavigation: string | null = null
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Seen here rather than in will-navigate: a page that navigates while still
  // loading fails loadURL as this fires, before will-navigate runs.
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.url.startsWith(`${SCHEME}:`)) blockedNavigation = event.url
  })
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('console-message', (event) => {
    // Electron's own dev-build warning about the renderer, not the page's.
    if (event.message.includes('Electron Security Warning')) return
    note(event.level === 'debug' ? 'log' : event.level, event.message)
  })
  // Offscreen windows paint into frames instead of a surface capturePage can
  // read: keep the latest one and capture from it.
  let lastFrame: Electron.NativeImage | null = null
  let onFrame: (() => void) | null = null
  contents.on('paint', (_event, _dirty, image) => {
    lastFrame = image
    onFrame?.()
  })
  const nextFrame = () => new Promise<void>((resolve) => {
    onFrame = () => {
      onFrame = null
      resolve()
    }
    contents.invalidate()
  })
  try {
    // A page that navigates itself while loading aborts the load; what it had
    // drawn by then is still worth a look.
    await withTimeout(win.loadURL(`${SCHEME}://${id}/`), LOAD_TIMEOUT_MS, 'Loading the page').catch((error: unknown) => {
      if (!blockedNavigation) throw error
    })
    await withTimeout(
      contents.executeJavaScript(
        `(document.readyState === 'complete' ? Promise.resolve() : new Promise((r) => addEventListener('load', r, { once: true })))
          .then(() => document.fonts.ready).then(() => new Promise((r) => setTimeout(r, ${SETTLE_MS})))`,
      ),
      LOAD_TIMEOUT_MS,
      'Waiting for the page to settle',
    )
    if (blockedNavigation) note('warning', `Blocked navigation to ${blockedNavigation}: the page must not navigate away; links open from the chat.`)
    const contentHeight = Number(await contents.executeJavaScript(CONTENT_HEIGHT)) || 1
    await withTimeout(nextFrame(), LOAD_TIMEOUT_MS, 'Painting the page')
    const frame = lastFrame as Electron.NativeImage | null
    if (!frame || frame.isEmpty()) throw new Error('The page painted nothing')
    const size = frame.getSize()
    const image = frame.crop({
      x: 0,
      y: 0,
      width: Math.min(size.width, input.width),
      height: Math.min(size.height, contentHeight, MAX_CAPTURE_HEIGHT),
    })
    return { jpeg: image.toJPEG(80), contentHeight, capturedHeight: image.getSize().height, console: consoleMessages }
  } finally {
    pages.delete(id)
    if (!win.isDestroyed()) win.destroy()
    release()
  }
}

/** Offers html_preview to agents. Call once the app is ready. */
export function registerHtmlSnapshotter(): void {
  setHtmlSnapshotter(snapshot)
}
