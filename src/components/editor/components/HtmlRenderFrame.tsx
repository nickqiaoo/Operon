import { useEffect, useRef, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { AppWindowIcon, ChevronRightIcon, ChevronUpIcon, DownloadIcon, Maximize2Icon, MinusIcon, PlusIcon, XIcon } from 'lucide-react'
import {
  HTML_RENDER_MAX_FIT_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_TOOL_NAME,
  buildHtmlRenderDocument,
  htmlRenderThemeMessage,
  htmlRenderZoomMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderImageRequest,
  readHtmlRenderKeyDown,
  readHtmlRenderLinkRequest,
  readHtmlRenderRef,
  type HtmlRenderRef,
  type HtmlRenderTheme,
} from '@shared/html-render'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ImageViewer } from '@/components/ai-elements/image-viewer'
import { getBaseUrl } from '@/lib/api-client'
import { resolveAttachmentUrl } from '@/lib/attachments'
import { openExternalUrl } from '@/lib/open-external'
import { useHtmlRenderTheme } from '@/hooks/useHtmlRenderTheme'
import { useIsMobile } from '@/hooks/useIsMobile'
import { resultText, toolNameOf } from './TaskCreatedRenderer'
import type { ToolPartLike } from './toolName'

/** The page an `html_render` call published, or null while it streams or when it failed. */
export function htmlRenderRefOf(toolPart: ToolPartLike): HtmlRenderRef | null {
  // Suffix match: `mcp__visual__html_render`, OpenCode's `visual_html_render`.
  if (!toolNameOf(toolPart).endsWith(HTML_RENDER_TOOL_NAME)) return null
  // Claude Code surfaces the MCP `structuredContent` as the output itself; the
  // other providers keep only the JSON text.
  const output = (toolPart as { output?: unknown; result?: unknown }).output ?? (toolPart as { result?: unknown }).result
  const structured = visualOf(output) ?? visualOf((output as { structuredContent?: unknown } | null | undefined)?.structuredContent)
  if (structured) return structured
  try {
    return visualOf(JSON.parse(resultText(toolPart)))
  } catch {
    return null
  }
}

function visualOf(value: unknown): HtmlRenderRef | null {
  if (!value || typeof value !== 'object' || !('visual' in value)) return null
  return readHtmlRenderRef(value.visual)
}

/** Asked by both MessagePartRenderer and isCompactEligible, so the call leaves the work group only when there is a page to draw. */
export function isHtmlRenderResult(toolPart: ToolPartLike): boolean {
  return htmlRenderRefOf(toolPart) !== null
}

// Attachments are content-addressed, so a URL's page never changes: fetch it once
// per session. The measured height is kept too, so a remount (scrolling back to a
// virtualized message) reserves the right space instead of jumping.
const pages = new Map<string, Promise<string>>()
const measuredHeights = new Map<string, number>()

async function loadPage(url: string): Promise<string> {
  let page = pages.get(url)
  if (!page) {
    page = (async () => {
      await getBaseUrl()
      const resolved = resolveAttachmentUrl(url)
      if (!resolved) throw new Error('Server address unknown')
      const res = await fetch(resolved)
      if (!res.ok) throw new Error(`${res.status}`)
      return res.text()
    })()
    pages.set(url, page)
    page.catch(() => pages.delete(url))
  }
  return page
}

function usePage(url: string): { page: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string; page: string | null; failed: boolean }>({ url, page: null, failed: false })
  useEffect(() => {
    let alive = true
    loadPage(url).then(
      (page) => alive && setState({ url, page, failed: false }),
      () => alive && setState({ url, page: null, failed: true }),
    )
    return () => {
      alive = false
    }
  }, [url])
  return state.url === url ? state : { page: null, failed: false }
}

// Collapsing is how a reader puts a page away once they're done with it, so it
// outlives the session. Pages are content-addressed: the URL is the page.
const COLLAPSED_KEY = 'operon.htmlRender.collapsed'
const MAX_COLLAPSED = 500

function readCollapsed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((url): url is string => typeof url === 'string') : []
  } catch {
    return []
  }
}

function writeCollapsed(url: string, collapsed: boolean) {
  const rest = readCollapsed().filter((entry) => entry !== url)
  const next = collapsed ? [...rest, url].slice(-MAX_COLLAPSED) : rest
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
  } catch {
    // Storage unavailable: the page still collapses, just not across reloads.
  }
}

// Icon-only actions over the page: color alone marks hover. A filled square
// inside the glass bar read as a box in a box, and sticks after a tap on touch.
const FRAME_ACTION = 'h-7 w-7 rounded-lg text-muted-foreground hover:bg-transparent hover:text-foreground active:bg-transparent active:opacity-70'

const fileNameFor = (title: string) =>
  `${title.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').trim().slice(0, 120) || 'Page'}.html`

/** Saves the page as a file that opens on its own, in the theme it is shown in now. */
function savePage(page: string, title: string, theme: HtmlRenderTheme) {
  const blob = new Blob([buildHtmlRenderDocument(page, theme, { standalone: true })], { type: 'text/html' })
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = fileNameFor(title)
  link.click()
  setTimeout(() => URL.revokeObjectURL(href), 60_000)
}

export function HtmlRenderRenderer({ toolPart }: { toolPart: ToolPartLike }) {
  const visual = htmlRenderRefOf(toolPart)
  return visual ? <HtmlRenderFrame visual={visual} /> : null
}

/**
 * The iframe and its side of the bridge, shared by the inline page and the
 * full-screen view.
 *
 * The page loads through `srcdoc`, not `src`: the attachment request needs auth
 * the iframe cannot send (a header on desktop, the broker's bearer and E2EE on
 * web), while fetch() gets it for free. Without `allow-same-origin` the page runs
 * on an opaque origin, so it cannot reach the app's storage, cookies or API token.
 */
function HtmlRenderDocument({
  page,
  title,
  theme,
  zoom = 1,
  onContentHeight,
  onOpenImage,
}: {
  page: string
  title: string
  theme: HtmlRenderTheme
  zoom?: number
  onContentHeight?: (height: number) => void
  onOpenImage: (image: { src: string; name: string }) => void
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  // Built with the theme at load time and then frozen: a theme change is posted
  // to the page instead, which keeps whatever state its scripts had.
  const [srcDoc] = useState(() => buildHtmlRenderDocument(page, theme))
  const latest = useRef({ theme, zoom, onContentHeight, onOpenImage })
  latest.current = { theme, zoom, onContentHeight, onOpenImage }

  const post = (message: unknown) => frameRef.current?.contentWindow?.postMessage(message, '*')

  useEffect(() => {
    post(htmlRenderThemeMessage(theme))
  }, [theme])

  useEffect(() => {
    post(htmlRenderZoomMessage(zoom))
  }, [zoom])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const height = readHtmlRenderContentHeight(event.data)
      if (height !== undefined) return latest.current.onContentHeight?.(height)
      const link = readHtmlRenderLinkRequest(event.data)
      if (link) return openExternalUrl(link)
      const image = readHtmlRenderImageRequest(event.data)
      if (image) return latest.current.onOpenImage(image)
      const key = readHtmlRenderKeyDown(event.data)
      // A focused frame keeps its keys. Replayed on the frame element, the key
      // bubbles through the app the way it would have from outside: ⌘K, Escape
      // closing the full-screen view, and the rest.
      if (key) frame.dispatchEvent(new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true }))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <iframe
      ref={frameRef}
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      className="block size-full border-0"
      // Must match the page's color-scheme, or Chrome paints an opaque backdrop
      // behind the transparent page.
      style={{ colorScheme: theme.appearance }}
      // The theme or zoom may have changed between building srcdoc and the load.
      onLoad={() => {
        post(htmlRenderThemeMessage(latest.current.theme))
        if (latest.current.zoom !== 1) post(htmlRenderZoomMessage(latest.current.zoom))
      }}
    />
  )
}

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2]

function HtmlRenderFullScreen({
  visual,
  page,
  theme,
  onSave,
  onOpenImage,
}: {
  visual: HtmlRenderRef
  page: string
  theme: HtmlRenderTheme
  onSave: () => void
  onOpenImage: (image: { src: string; name: string }) => void
}) {
  const intl = useIntl()
  const [zoomIndex, setZoomIndex] = useState(ZOOM_STEPS.indexOf(1))
  const zoom = ZOOM_STEPS[zoomIndex]

  return (
    <DialogContent
      aria-describedby={undefined}
      className="flex h-[94dvh] w-[96vw] max-w-none flex-col gap-0 overflow-hidden rounded-xl border-border/40 bg-background p-0 shadow-modal sm:max-w-none"
      showCloseButton={false}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/40 px-4 py-2.5">
        <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium">{visual.title}</DialogTitle>
        <div className="flex items-center gap-0.5" role="group" aria-label={intl.formatMessage({ id: 'editor.htmlRender.zoomControls', defaultMessage: 'Zoom' })}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 rounded-lg"
            aria-label={intl.formatMessage({ id: 'editor.htmlRender.zoomOut', defaultMessage: 'Zoom out' })}
            disabled={zoomIndex === 0}
            onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
          >
            <MinusIcon className="h-3.5 w-3.5" />
          </Button>
          <button
            type="button"
            className="h-7 w-12 rounded-lg text-center text-xs tabular-nums text-muted-foreground transition-colors hover:bg-accent-hover hover:text-foreground"
            title={intl.formatMessage({ id: 'editor.htmlRender.resetZoom', defaultMessage: 'Reset zoom' })}
            onClick={() => setZoomIndex(ZOOM_STEPS.indexOf(1))}
          >
            {Math.round(zoom * 100)}%
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 rounded-lg"
            aria-label={intl.formatMessage({ id: 'editor.htmlRender.zoomIn', defaultMessage: 'Zoom in' })}
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            onClick={() => setZoomIndex((index) => Math.min(ZOOM_STEPS.length - 1, index + 1))}
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </Button>
          <span className="mx-1.5 h-4 w-px bg-border/60" />
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 rounded-lg"
            aria-label={intl.formatMessage({ id: 'editor.htmlRender.save', defaultMessage: 'Save as HTML' })}
            title={intl.formatMessage({ id: 'editor.htmlRender.save', defaultMessage: 'Save as HTML' })}
            onClick={onSave}
          >
            <DownloadIcon className="h-3.5 w-3.5" />
          </Button>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-7 w-7 rounded-lg"
              aria-label={intl.formatMessage({ id: 'editor.htmlRender.close', defaultMessage: 'Close' })}
            >
              <XIcon className="h-3.5 w-3.5" />
            </Button>
          </DialogClose>
        </div>
      </header>
      {/* At its own width the page lays out again, so it scrolls inside the frame here. */}
      <div className="min-h-0 flex-1">
        <HtmlRenderDocument page={page} title={visual.title} theme={theme} zoom={zoom} onOpenImage={onOpenImage} />
      </div>
    </DialogContent>
  )
}

/** A visual reply, inline where its call appears. */
export function HtmlRenderFrame({ visual }: { visual: HtmlRenderRef }) {
  const intl = useIntl()
  const theme = useHtmlRenderTheme()
  const { page, failed } = usePage(visual.url)
  const [contentHeight, setContentHeight] = useState(() => measuredHeights.get(visual.url))
  const [fullScreen, setFullScreen] = useState(false)
  // The phone shell (same test as Root): the page already spans the screen, and
  // a dialog there runs under the native bars, so it has no full-screen view.
  const isMobile = useIsMobile()
  const phone = __APP_TARGET__ === 'web' && isMobile
  const [image, setImage] = useState<{ src: string; name: string } | null>(null)
  const [collapsed, setCollapsed] = useState(() => readCollapsed().includes(visual.url))
  const toggleCollapsed = (next: boolean) => {
    writeCollapsed(visual.url, next)
    setCollapsed(next)
  }

  // Put away, the page reads as one more step in the turn, so it takes the tool
  // rows' look (chevron, icon, muted name) rather than a card of its own.
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => toggleCollapsed(false)}
        aria-expanded={false}
        className="my-1 flex w-full min-w-0 items-center gap-1.5 text-left text-muted-foreground transition-colors hover:text-foreground"
        aria-label={intl.formatMessage({ id: 'editor.htmlRender.expand', defaultMessage: 'Show {title}' }, { title: visual.title })}
      >
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/60" />
        <AppWindowIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate text-sm font-medium">{visual.title}</span>
      </button>
    )
  }

  if (failed) {
    return (
      <p className="my-2 text-xs text-muted-foreground">
        <FormattedMessage id="editor.htmlRender.unavailable" defaultMessage="Unable to load {title}" values={{ title: visual.title }} />
      </p>
    )
  }

  // The page's own height wins over the agent's guess: fonts here often wrap it
  // taller, and a frame even a few pixels short scrolls and steals the reader's wheel.
  const height = contentHeight === undefined
    ? visual.height
    : Math.min(HTML_RENDER_MAX_FIT_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.ceil(contentHeight)))
  const save = () => page !== null && savePage(page, visual.title, theme)

  return (
    <div className="group/html-render relative my-2" style={{ height }}>
      {page !== null && (
        <>
          <HtmlRenderDocument
            key={visual.url}
            page={page}
            title={visual.title}
            theme={theme}
            onContentHeight={(next) => {
              measuredHeights.set(visual.url, next)
              setContentHeight(next)
            }}
            onOpenImage={setImage}
          />
          {/* Out of the way until the pointer is over the page; always there on touch. */}
          <div className="liquid-glass absolute top-2 right-2 flex items-center gap-0.5 rounded-lg p-0.5 opacity-0 transition-opacity duration-150 group-hover/html-render:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
            <Button
              variant="ghost"
              size="icon-sm"
              className={FRAME_ACTION}
              aria-label={intl.formatMessage({ id: 'editor.htmlRender.collapse', defaultMessage: 'Collapse' })}
              title={intl.formatMessage({ id: 'editor.htmlRender.collapse', defaultMessage: 'Collapse' })}
              onClick={() => toggleCollapsed(true)}
              aria-expanded
            >
              <ChevronUpIcon className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={FRAME_ACTION}
              aria-label={intl.formatMessage({ id: 'editor.htmlRender.save', defaultMessage: 'Save as HTML' })}
              title={intl.formatMessage({ id: 'editor.htmlRender.save', defaultMessage: 'Save as HTML' })}
              onClick={save}
            >
              <DownloadIcon className="h-3.5 w-3.5" />
            </Button>
            {!phone && (
              <Button
                variant="ghost"
                size="icon-sm"
                className={FRAME_ACTION}
                aria-label={intl.formatMessage({ id: 'editor.htmlRender.fullScreen', defaultMessage: 'Open full screen' })}
                title={intl.formatMessage({ id: 'editor.htmlRender.fullScreen', defaultMessage: 'Open full screen' })}
                onClick={() => setFullScreen(true)}
              >
                <Maximize2Icon className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <Dialog open={fullScreen && !phone} onOpenChange={setFullScreen}>
            {fullScreen && !phone && <HtmlRenderFullScreen visual={visual} page={page} theme={theme} onSave={save} onOpenImage={setImage} />}
          </Dialog>
        </>
      )}
      <Dialog open={image !== null} onOpenChange={(open) => !open && setImage(null)}>
        {image && <ImageViewer src={image.src} filename={image.name} />}
      </Dialog>
    </div>
  )
}
