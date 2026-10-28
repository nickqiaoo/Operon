/**
 * Visual replies: an agent publishes a self-contained HTML page with the
 * `html_render` tool (server/src/routes/visual-mcp.ts) and the chat shows it
 * inline in a sandboxed iframe (src/components/editor/components/HtmlRenderFrame.tsx).
 *
 * The stored page is the agent's HTML with local images inlined, nothing more.
 * The theme and the bridge script are added by the client at render time
 * ({@link buildHtmlRenderDocument}), so a page published today picks up later
 * fixes to the bridge, and always matches whatever theme is active.
 *
 * Host and page talk JSON-RPC over postMessage using the MCP Apps method names,
 * so MCP Apps can reuse the same bridge later.
 */

export const HTML_RENDER_TOOL_NAME = 'html_render'
export const HTML_RENDER_MIN_HEIGHT = 80
export const HTML_RENDER_MAX_HEIGHT = 2000
/** The client fits the frame to the live page up to this. vh units are rejected at publish, so only a runaway page reaches it. */
export const HTML_RENDER_MAX_FIT_HEIGHT = 20_000
export const HTML_RENDER_MAX_TITLE_LENGTH = 200
/** The HTML the agent sends, before images are inlined. */
export const HTML_RENDER_MAX_SOURCE_BYTES = 512_000
/** The stored page, after images are inlined. */
export const HTML_RENDER_MAX_PAGE_BYTES = 8 * 1024 * 1024
/** The reply column on desktop, and html_preview's default width. */
export const HTML_RENDER_COLUMN_WIDTH = 720
export const HTML_RENDER_PREVIEW_MIN_WIDTH = 240
export const HTML_RENDER_PREVIEW_MAX_WIDTH = 1600
export const HTML_RENDER_PREVIEW_TOOL_NAME = 'html_preview'

/** What `html_render` returns, under `visual` in its JSON result. */
export interface HtmlRenderRef {
  /** `/api/attachments/<sha256>`, resolved against the current base URL at render time. */
  url: string
  title: string
  height: number
}

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)))
}

export function readHtmlRenderRef(value: unknown): HtmlRenderRef | null {
  if (typeof value !== 'object' || value === null) return null
  const { url, title, height } = value as Record<string, unknown>
  if (typeof url !== 'string' || !/^\/api\/attachments\/[a-f0-9]{64}$/.test(url)) return null
  if (typeof height !== 'number' || !Number.isFinite(height)) return null
  return {
    url,
    title: typeof title === 'string' && title.trim() ? title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) : 'Page',
    height: clampHtmlRenderHeight(height),
  }
}

/**
 * Variables the page can use, and the app token each one reads. Short names on
 * purpose: they are what models already write for shadcn-style pages.
 */
export const HTML_RENDER_THEME_TOKENS: Record<string, string> = {
  '--background': '--color-background',
  '--foreground': '--color-foreground',
  '--muted': '--color-muted',
  '--muted-foreground': '--color-muted-foreground',
  '--card': '--color-card',
  '--card-foreground': '--color-card-foreground',
  '--popover': '--color-popover',
  '--popover-foreground': '--color-popover-foreground',
  '--secondary': '--color-secondary',
  '--secondary-foreground': '--color-secondary-foreground',
  '--border': '--color-border',
  '--ring': '--color-ring',
  '--primary': '--color-primary',
  '--primary-foreground': '--color-primary-foreground',
  '--accent': '--color-brand',
  '--accent-foreground': '--color-brand-fg',
  '--link': '--color-link',
  '--destructive': '--color-destructive',
  '--destructive-foreground': '--color-destructive-foreground',
  '--success': '--color-status-ok',
  '--warning': '--color-status-warn',
  '--danger': '--color-status-error',
  '--info': '--color-status-info',
  '--chart-1': '--color-chart-1',
  '--chart-2': '--color-chart-2',
  '--chart-3': '--color-chart-3',
  '--chart-4': '--color-chart-4',
  '--chart-5': '--color-chart-5',
  '--chart-6': '--color-chart-6',
}

export interface HtmlRenderTheme {
  appearance: 'light' | 'dark'
  variables: Record<string, string>
}

const PREVIEW_FONTS = {
  '--font-sans': '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "PingFang SC", sans-serif',
  '--font-mono': '"SF Mono", Menlo, Monaco, ui-monospace, monospace',
  '--radius': '12px',
}

/**
 * The default theme's values (src/styles/globals.css), for where there is no app
 * window to read them from: html_preview renders in the main process. A ported
 * theme differs, which a preview screenshot can live with; the chat itself reads
 * the live values (useHtmlRenderTheme).
 */
export const HTML_RENDER_DEFAULT_THEMES: Record<HtmlRenderTheme['appearance'], HtmlRenderTheme> = {
  light: {
    appearance: 'light',
    variables: {
      '--background': '#ffffff', '--foreground': '#1a1b23', '--muted': '#edf0f5', '--muted-foreground': '#687084',
      '--card': '#ffffff', '--card-foreground': '#1a1b23', '--popover': '#ffffff', '--popover-foreground': '#1a1b23',
      '--secondary': '#eef1f7', '--secondary-foreground': '#1a1b23', '--border': '#dfe3eb', '--ring': '#9b9db5',
      '--primary': '#1a1b23', '--primary-foreground': '#ffffff', '--accent': '#6358DC', '--accent-foreground': '#ffffff',
      '--link': '#0357a6', '--destructive': '#ef4444', '--destructive-foreground': '#ffffff',
      '--success': '#047857', '--warning': '#b45309', '--danger': '#b91c1c', '--info': '#0369a1',
      '--chart-1': '#2a78d6', '--chart-2': '#eb6834', '--chart-3': '#1baf7a', '--chart-4': '#eda100', '--chart-5': '#e87ba4', '--chart-6': '#008300',
      ...PREVIEW_FONTS,
    },
  },
  dark: {
    appearance: 'dark',
    variables: {
      '--background': '#0b0b0d', '--foreground': '#f0f0f2', '--muted': '#1b1b1f', '--muted-foreground': '#aaaab2',
      '--card': '#1a1a1e', '--card-foreground': '#f0f0f2', '--popover': '#1a1a1e', '--popover-foreground': '#f0f0f2',
      '--secondary': '#2a2a2f', '--secondary-foreground': '#f0f0f2', '--border': '#2b2b31', '--ring': '#5f5f68',
      '--primary': '#fafafa', '--primary-foreground': '#09090b', '--accent': '#8B7DF0', '--accent-foreground': '#ffffff',
      '--link': '#8cadd4', '--destructive': '#991b1b', '--destructive-foreground': '#fecaca',
      '--success': '#6ee7b7', '--warning': '#fcd34d', '--danger': '#fca5a5', '--info': '#7dd3fc',
      '--chart-1': '#3987e5', '--chart-2': '#d95926', '--chart-3': '#199e70', '--chart-4': '#c98500', '--chart-5': '#d55181', '--chart-6': '#008300',
      ...PREVIEW_FONTS,
    },
  },
}

export const HTML_RENDER_THEME_GUIDE = [
  'Use these CSS variables, never fixed colors, so the page follows the app theme and light/dark mode:',
  `${Object.keys(HTML_RENDER_THEME_TOKENS).join(', ')}, --radius, --font-sans, --font-mono.`,
  'The page already sets text color and font, and is transparent over the chat background.',
].join(' ')

export const HTML_RENDER_LAYOUT_GUIDE = [
  'The frame is the width of the reply (about 720px on desktop, 360px on phones) and sits on the chat background.',
  'Give html, body and the outer element no background color, no outer card or border, no banner title, and no side padding.',
  'A box that needs its own background gets 16px padding and var(--radius) corners. Give charts fixed pixel heights.',
  'Let content set the height: do not use vh units or height:100% on html or body.',
].join(' ')

export const HOST_CONTEXT_CHANGED_METHOD = 'ui/notifications/host-context-changed'
export const SIZE_CHANGED_METHOD = 'ui/notifications/size-changed'
export const OPEN_LINK_METHOD = 'ui/open-link'
// Not in MCP Apps: our own additions to the bridge.
export const OPEN_IMAGE_METHOD = 'operon/open-image'
export const KEY_DOWN_METHOD = 'operon/keydown'
export const SET_ZOOM_METHOD = 'operon/set-zoom'

function rpc(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  return record.jsonrpc === '2.0' && typeof record.method === 'string' ? record : null
}

export function readHtmlRenderContentHeight(data: unknown): number | undefined {
  const message = rpc(data)
  if (message?.method !== SIZE_CHANGED_METHOD) return undefined
  const height = (message.params as { height?: unknown } | undefined)?.height
  return typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : undefined
}

export function readHtmlRenderLinkRequest(data: unknown): string | undefined {
  const message = rpc(data)
  if (message?.method !== OPEN_LINK_METHOD) return undefined
  const url = (message.params as { url?: unknown } | undefined)?.url
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined
}

/** Images the page shows are remote or inlined `data:image/` URLs; nothing else opens. */
export function readHtmlRenderImageRequest(data: unknown): { src: string; name: string } | undefined {
  const message = rpc(data)
  if (message?.method !== OPEN_IMAGE_METHOD) return undefined
  const { src, name } = (message.params ?? {}) as { src?: unknown; name?: unknown }
  if (typeof src !== 'string' || !/^(?:https?:\/\/|data:image\/)/i.test(src)) return undefined
  const label = typeof name === 'string' ? name.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) : ''
  return { src, name: label || 'Image' }
}

export interface HtmlRenderKeyDown {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export function readHtmlRenderKeyDown(data: unknown): HtmlRenderKeyDown | undefined {
  const message = rpc(data)
  if (message?.method !== KEY_DOWN_METHOD) return undefined
  const p = (message.params ?? {}) as Record<string, unknown>
  if (typeof p.key !== 'string' || typeof p.code !== 'string') return undefined
  return { key: p.key, code: p.code, metaKey: p.metaKey === true, ctrlKey: p.ctrlKey === true, shiftKey: p.shiftKey === true, altKey: p.altKey === true }
}

export function htmlRenderZoomMessage(zoom: number) {
  return { jsonrpc: '2.0', method: SET_ZOOM_METHOD, params: { zoom } } as const
}

export function htmlRenderThemeMessage(theme: HtmlRenderTheme) {
  return {
    jsonrpc: '2.0',
    method: HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  } as const
}

// Transparent so the page sits on whatever surface hosts it (chat, assistant page).
// That only holds while the iframe element's color-scheme matches the page's;
// the host sets both from the same appearance.
const BASE_CSS =
  'html{background:transparent;color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;' +
  '-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}' +
  'html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}' +
  // Painted inside the element, so the frame edge never clips a focus ring.
  ':focus-visible{outline:2px solid var(--ring);outline-offset:-2px}' +
  ':where(img:not(a[href] img,button img)){cursor:zoom-in}'

/** Values are app tokens, but strip anything that could close the rule anyway. */
function rootRule(theme: HtmlRenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .filter(([name]) => /^--[a-z0-9-]+$/.test(name))
    .map(([name, value]) => `${name}:${value.replace(/[;{}<>]/g, '')};`)
    .join('')
  return `:root{color-scheme:${theme.appearance};${declarations}}`
}

// Runs in the page. Re-applies the theme when the host sends a new one, reports
// the content height so the frame never scrolls, and hands to the host what a
// sandboxed frame cannot do itself: http(s) links (no popups, and it must not
// navigate itself away), opening an image large, and app shortcuts (a focused
// frame keeps its keys). Saved as a standalone file, only the theme part runs.
const BOOTSTRAP_SCRIPT = `(function(){
var s=document.getElementById("operon-theme"),B=${JSON.stringify(BASE_CSS)},P=window.parent,F=P!==window;
function post(m,p){P.postMessage({jsonrpc:"2.0",method:m,params:p},"*");}
window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(!F||e.source!==P||!d||d.jsonrpc!=="2.0"||!p)return;
if(d.method===${JSON.stringify(SET_ZOOM_METHOD)}){var z=Number(p.zoom);if(z>0&&z<=4)document.documentElement.style.zoom=String(z);return;}
if(d.method!==${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}||!p.styles||!s)return;var c=":root{color-scheme:"+(p.theme==="light"?"light":"dark")+";",v=p.styles.variables||{};for(var k in v){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(v[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+B;});
if(!F)return;
document.addEventListener("click",function(e){if(!e.isTrusted||e.defaultPrevented)return;var path=e.composedPath(),l=path.find(function(t){return t&&t.matches&&t.matches("a[href]");}),u;
if(!l){var t=path[0];if(e.button===0&&t&&t.tagName==="IMG"&&!t.closest("button")){u=t.currentSrc||t.src;if(u)setTimeout(function(){if(!e.defaultPrevented)post(${JSON.stringify(OPEN_IMAGE_METHOD)},{src:u,name:t.alt||t.title||""});});}return;}
var h=l.getAttribute("href")||"";if(h.charAt(0)==="#")return;e.preventDefault();try{u=new URL(h,document.baseURI);}catch(x){return;}if(/^https?:$/.test(u.protocol))post(${JSON.stringify(OPEN_LINK_METHOD)},{url:u.href});});
window.addEventListener("keydown",function(e){var t=e.composedPath()[0];if(!e.isTrusted||e.isComposing||/^(?:Meta|Control|Shift|Alt)$/.test(e.key)||!(e.metaKey||e.ctrlKey||e.key==="Escape")||t&&(t.isContentEditable||/^(?:INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))return;
setTimeout(function(){if(!e.defaultPrevented)post(${JSON.stringify(KEY_DOWN_METHOD)},{key:e.key,code:e.code,metaKey:e.metaKey,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey});});});
var last,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===last)return;last=v;post(${JSON.stringify(SIZE_CHANGED_METHOD)},{height:v});};
if(window.ResizeObserver){var o=new ResizeObserver(z);o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(document.body)o.observe(document.body);});}
document.addEventListener("DOMContentLoaded",z);window.addEventListener("load",z);
})();`

/**
 * Blanks comments and raw-text elements without shifting offsets, so the
 * `<head>` search below cannot land inside a script or a comment.
 */
function blankNonMarkup(html: string): string {
  return html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|template|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi,
    (match) => ' '.repeat(match.length),
  )
}

/**
 * The page as the iframe loads it: the stored HTML with theme and bridge injected
 * first in `<head>`. `standalone` is for a saved file, opened with no chat behind
 * its transparent background: it paints the theme's own.
 */
export function buildHtmlRenderDocument(html: string, theme: HtmlRenderTheme, options?: { standalone?: boolean }): string {
  const scan = blankNonMarkup(html)
  const markup = [
    /<meta\s[^>]*charset/i.test(scan.slice(0, 4096)) ? '' : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(scan) ? '' : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="operon-theme">${rootRule(theme)}${BASE_CSS}</style>`,
    options?.standalone ? '<style>html{background:var(--background)}</style>' : '',
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
  ].join('')
  const head = /<head(?:\s[^>]*)?>/i.exec(scan)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + markup + html.slice(at)
  }
  const root = /<html(?:\s[^>]*)?>/i.exec(scan)
  if (root) {
    const at = root.index + root[0].length
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) {
    const at = doctype[0].length
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`
  }
  return `<!doctype html><head>${markup}</head>${html}`
}
