import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  app,
  ipcMain,
  webContents,
  type BrowserWindow,
  type Session,
  type WebContents,
} from 'electron'
import {
  IabBackend,
  type BrowserUseDownloadChange,
  type BrowserUseTab,
  type CdpDriver,
  type CdpEvent,
} from '../packages/browser-use/IabBackend.ts'

/**
 * The real CDP driver behind the IAB backend: it lands browser-use wire RPCs on
 * the browser the user can actually see, the <webview> owned by
 * `src/components/browser/WebviewInstance.ts`.
 *
 * Layering rule, the same one @operon/computer-use follows: the package never
 * imports electron.
 *   packages/browser-use/   wire and protocol. Plain Node, testable, with
 *                           CdpDriver as an interface.
 *   electron/ (this file)   the only place that touches Electron.
 *
 * ## tabId on the wire must be a positive integer
 *
 * Operon's own `instanceId` (a base36 string like `"4gjf9p"`) cannot be used.
 * The wire protocol rejects a non-integer tabId outright, and the tool layer
 * above it accepts a string but only one that converts to a positive integer,
 * so a base36 id fails on both sides.
 *
 * So tabId is `webContents.id`, which Electron guarantees to be a positive,
 * globally unique integer, and the wire keeps it as a number. It is also the
 * thing we ultimately need to resolve to, which saves a mapping layer.
 *
 * ## What instanceId is still for
 *
 * Recognising which webContents are browser tabs at all. The main window,
 * devtools and the annotation window are not. The renderer has to register
 * them, because <webview> is created in the renderer process and the main
 * process has no mapping of its own (`will-attach-webview` hands over
 * webPreferences and nothing that identifies the instance).
 */

/**
 * operon instanceId -> { webContents.id, which is the tabId on the wire, owner }.
 *
 * `owner` is the conversation (chatId) whose browser this tab belongs to. The
 * browser panel swaps contents when you switch conversations, so every tab needs
 * an owner. A design that gives each conversation its own browser host gets this
 * for free; we serve every conversation from one host, so ownership has to be
 * recorded explicitly.
 *
 * The renderer reports it at registration time, since it is the side that knows
 * which conversation's panel the tab landed in.
 */
const tabRegistry = new Map<string, { wcId: number; owner?: string }>()

interface DownloadGrant {
  sessionId: string
  url: string
  grantedAt: number
}

const DOWNLOAD_GRANT_TTL_MS = 10_000
const downloadGrants = new Map<number, DownloadGrant>()
const downloadSubscribers = new Set<(change: BrowserUseDownloadChange) => void>()
const downloadSessions = new WeakSet<Session>()
const activeDownloadPaths = new Set<string>()

function emitDownloadChange(change: BrowserUseDownloadChange): void {
  for (const subscriber of downloadSubscribers) subscriber(change)
}

function reserveDownloadPath(filename: string): string {
  const basename = path.basename(filename.trim()) || 'download'
  const parsed = path.parse(basename)
  for (let index = 0; ; index += 1) {
    const candidate = path.join(
      app.getPath('downloads'),
      index === 0 ? basename : `${parsed.name} (${index})${parsed.ext}`,
    )
    if (!fs.existsSync(candidate) && !activeDownloadPaths.has(candidate)) {
      activeDownloadPaths.add(candidate)
      return candidate
    }
  }
}

function ensureDownloadSession(browserSession: Session): void {
  if (downloadSessions.has(browserSession)) return
  downloadSessions.add(browserSession)
  browserSession.on('will-download', (_event, item, contents) => {
    const wcId = contents?.id
    if (wcId == null) return
    const grant = downloadGrants.get(wcId)
    if (grant == null || Date.now() - grant.grantedAt > DOWNLOAD_GRANT_TTL_MS) {
      downloadGrants.delete(wcId)
      return
    }
    const url = item.getURL()
    const chain = item.getURLChain()
    if (grant.url !== url && !chain.includes(grant.url)) return
    downloadGrants.delete(wcId)

    const savePath = reserveDownloadPath(item.getFilename())
    item.setSavePath(savePath)
    const id = randomUUID()
    const notify = (status: BrowserUseDownloadChange['status']) =>
      emitDownloadChange({
        filename: savePath,
        id,
        session_id: grant.sessionId,
        status,
        url: grant.url,
      })
    let finished = false
    const finish = (status: BrowserUseDownloadChange['status']) => {
      if (finished) return
      finished = true
      activeDownloadPaths.delete(savePath)
      notify(status)
    }
    notify('started')
    item.on('updated', (_event, state) => {
      if (state === 'interrupted' && !item.canResume()) finish('failed')
      else notify('in_progress')
    })
    item.once('done', (_event, state) => {
      if (state === 'completed') finish('complete')
      else if (state === 'cancelled') finish('canceled')
      else finish('failed')
    })
  })
}

// ---- A request channel from main to renderer ----
// Opening and closing tabs has to happen in the renderer, because that is where
// the tabs store lives, while this driver runs in the main process. The existing
// IPC only covers renderer-to-main (invoke/handle) and one-way main-to-renderer
// pushes like updater:status, so this adds request/response correlated by reqId.
let mainWindowRef: BrowserWindow | null = null
let reqSeq = 0
const pendingReqs = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

/** Timeout for renderer-side actions, so a stuck UI never leaves an agent waiting forever. */
const RENDERER_REQ_TIMEOUT_MS = 10_000

function askRenderer<T>(action: string, payload: unknown): Promise<T> {
  const win = mainWindowRef
  if (win == null || win.isDestroyed()) return Promise.reject(new Error('operon window is not available'))
  const id = ++reqSeq
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReqs.delete(id)
      reject(new Error(`Renderer did not answer "${action}" in ${RENDERER_REQ_TIMEOUT_MS}ms`))
    }, RENDERER_REQ_TIMEOUT_MS)
    pendingReqs.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v as T) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    win.webContents.send('browser-use:request', { id, action, payload })
  })
}

/** Called from the renderer to register or unregister a browser tab's
 *  webContents, and to deliver askRenderer responses back. */
export function registerBrowserUseIpc(win: BrowserWindow): void {
  mainWindowRef = win
  ipcMain.handle('browser:register-tab', (_e, instanceId: string, webContentsId: number, owner?: string) => {
    tabRegistry.set(instanceId, { wcId: webContentsId, owner })
  })
  ipcMain.handle('browser:unregister-tab', (_e, instanceId: string) => {
    const wcId = tabRegistry.get(instanceId)?.wcId
    if (wcId != null) downloadGrants.delete(wcId)
    tabRegistry.delete(instanceId)
  })
  ipcMain.on('browser-use:response', (_e, res: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    const p = pendingReqs.get(res.id)
    if (!p) return
    pendingReqs.delete(res.id)
    if (res.ok) p.resolve(res.result)
    else p.reject(new Error(res.error ?? 'renderer error'))
  })
}

/** tabId on the wire, which is webContents.id, to WebContents. Only registered
 *  browser tabs resolve. */
function resolveWebContents(id: number): WebContents {
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid tabId: ${id}`)
  // Only registered browser tabs may be driven. An agent must never reach the
  // main window, devtools or the annotation window.
  if (![...tabRegistry.values()].some((v) => v.wcId === id)) throw new Error(`Unknown tabId: ${id}`)
  const wc = webContents.fromId(id)
  // A destroyed webview can leave a stale registry entry behind: the renderer's
  // unregister is not guaranteed to arrive.
  if (wc == null || wc.isDestroyed()) {
    for (const [k, v] of tabRegistry) if (v.wcId === id) tabRegistry.delete(k)
    throw new Error(`Tab is gone: ${id}`)
  }
  return wc
}

/** CDP protocol version. Electron's debugger.attach requires it explicitly. */
const CDP_VERSION = '1.3'

export function createElectronCdpDriver(): CdpDriver {
  /** Subscribers to CDP events; IabBackend is the only one. */
  const eventSubscribers = new Set<(evt: CdpEvent) => void>()
  /** tabId to the message listener already installed on that webContents, so it
   *  is never installed twice. */
  const messageListeners = new Map<number, (...args: unknown[]) => void>()

  /**
   * Install the CDP event listener for a tab. This must happen at attach time,
   * or anything that waits on events, `goto()` among them, times out.
   */
  const ensureEventListener = (tabId: number, wc: WebContents) => {
    if (messageListeners.has(tabId)) return
    const listener = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
      const sid = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
      const evt: CdpEvent = {
        // The client's `attachedTabIdForCdpEvent` only accepts
        // `typeof tabId === "number"` (see CdpEventSource.tabId).
        source: { tabId, ...(sid ? { sessionId: sid } : {}) },
        method,
        ...(params != null && typeof params === 'object' ? { params } : {}),
      }
      for (const cb of eventSubscribers) cb(evt)
    }
    wc.debugger.on('message', listener as never)
    messageListeners.set(tabId, listener as never)
  }

  const dropEventListener = (tabId: number, wc?: WebContents) => {
    const listener = messageListeners.get(tabId)
    if (!listener) return
    messageListeners.delete(tabId)
    try {
      if (wc && !wc.isDestroyed()) wc.debugger.removeListener('message', listener as never)
    } catch {
      // The webContents is gone, and its listener went with it.
    }
  }

  return {
    onCdpEvent(cb) {
      eventSubscribers.add(cb)
      return () => eventSubscribers.delete(cb)
    },

    onDownloadChange(cb) {
      downloadSubscribers.add(cb)
      return () => downloadSubscribers.delete(cb)
    },

    async attach(tabId) {
      const wc = resolveWebContents(tabId)
      // Subscribe before attaching: once attached, Page.enable and friends start
      // emitting events immediately.
      ensureEventListener(tabId, wc)
      // Attaching twice throws, so this is made idempotent to survive a backend
      // reconnect. Note the debugger is exclusive: if the user opens DevTools on
      // this webview by hand they take it, and attach then fails with
      // "Another debugger is already attached".
      if (wc.debugger.isAttached()) return
      wc.debugger.attach(CDP_VERSION)
    },

    async detach(tabId) {
      const wc = resolveWebContents(tabId)
      dropEventListener(tabId, wc)
      if (wc.debugger.isAttached()) wc.debugger.detach()
    },

    async sendCommand(tabId, method, params, sessionId) {
      const wc = resolveWebContents(tabId)
      // A client is not required to attach first (an executeCdp can arrive cold),
      // so recover here rather than fail.
      ensureEventListener(tabId, wc)
      if (!wc.debugger.isAttached()) wc.debugger.attach(CDP_VERSION)
      // The third argument, sessionId, targets a child target such as an OOPIF or
      // cross-origin iframe. Pass undefined for the top-level tab.
      return await wc.debugger.sendCommand(
        method,
        (params ?? {}) as Record<string, unknown>,
        sessionId,
      )
    },

    async setCaptureSurface(tabId, size) {
      const instanceId = instanceIdOf(tabId)
      if (instanceId == null) throw new Error(`Unknown tabId: ${tabId}`)
      // Actually resize the webview container in the renderer. A device metrics
      // override only changes the numbers CDP reports; it will not make an
      // invisible guest produce frames. After the renderer answers, the backend
      // still polls layout metrics.
      await askRenderer<void>('setCaptureSurface', { instanceId, size })
    },

    async setBrowserUseActive(tabId, active) {
      const instanceId = instanceIdOf(tabId)
      if (instanceId == null) throw new Error(`Unknown tabId: ${tabId}`)
      // While Browser Use holds a tab, keep a real paint host for it even when its
      // conversation is not in the foreground. An ordinary viewport screenshot
      // carries no full-page clip and so never needs a temporary capture surface.
      await askRenderer<void>('setBrowserUseActive', { instanceId, active })
    },

    async setCursor(tabId, cursor) {
      const instanceId = instanceIdOf(tabId)
      if (instanceId == null) throw new Error(`Unknown tabId: ${tabId}`)
      await askRenderer<void>('setBrowserUseCursor', { instanceId, cursor })
    },

    async allowDownload(tabId, url, sessionId) {
      const wc = resolveWebContents(tabId)
      ensureDownloadSession(wc.session)
      downloadGrants.set(wc.id, { grantedAt: Date.now(), sessionId, url })
    },

    async setVisible(tabId, visible) {
      const instanceId = instanceIdOf(tabId)
      if (instanceId == null) throw new Error(`Unknown tabId: ${tabId}`)
      await askRenderer<void>('setBrowserVisibility', { instanceId, visible })
    },

    async isVisible(tabId) {
      const instanceId = instanceIdOf(tabId)
      if (instanceId == null) return false
      return await askRenderer<boolean>('getBrowserVisibility', { instanceId })
    },

    async setViewport(tabId, size) {
      const instanceId = instanceIdOf(tabId)
      if (instanceId == null) throw new Error(`Unknown tabId: ${tabId}`)
      await askRenderer<void>('setBrowserViewport', { instanceId, size })
    },

    async selectTab(tabId) {
      const instanceId = instanceIdOf(tabId)
      if (instanceId == null) throw new Error(`Unknown tabId: ${tabId}`)
      await askRenderer<void>('selectTab', { instanceId })
    },

    async listTabs() {
      // The wire shape for a serialised tab is {id, title, active, url}, filled
      // from getTitle() and getURL().
      // id directly uses the numeric webContents.id; only the model-facing SDK
      // converts it to a string (see the file header contract notes).
      const presentation = await askRenderer<{ activeInstanceIds: string[] }>(
        'getTabPresentation',
        {},
      ).catch(() => ({ activeInstanceIds: [] }))
      const activeInstanceIds = new Set(presentation.activeInstanceIds)
      const tabs: BrowserUseTab[] = []
      for (const [instanceId, entry] of tabRegistry) {
        const wc = webContents.fromId(entry.wcId)
        if (wc == null || wc.isDestroyed()) {
          tabRegistry.delete(instanceId)
          continue
        }
        tabs.push({
          // tabId is a number on the wire; webContents.id is what we use for it.
          id: entry.wcId,
          title: wc.getTitle(),
          url: wc.getURL(),
          active: activeInstanceIds.has(instanceId),
          // Ownership: IabBackend uses this to decide which session can see the
          // tab (see BrowserUseTab.owner).
          owner: entry.owner,
        })
      }
      return tabs
    },

    async createTab(url, owner) {
      // The renderer has to open it, since the tabs store lives there. It returns
      // the new tab's instanceId; the webContents.id only arrives once dom-ready
      // registers it back.
      //
      // An empty url has to become about:blank rather than being passed through
      // as ''. The renderer reads an empty url as "open the landing page", the
      // human New Tab behaviour, which is a pure React page with no webview
      // attached at all: no webContents, so it never registers, so
      // waitForRegistration times out after 10s. `tabs.new()` is normally called
      // with no url, which makes this the agent's default path.
      // owner rides along so the renderer puts the tab in that conversation's panel.
      const instanceId = await askRenderer<string>('createTab', { url: url || 'about:blank', chatId: owner })
      const wcId = await waitForRegistration(instanceId)
      const wc = webContents.fromId(wcId)
      return {
        id: wcId,
        title: wc?.getTitle() ?? '',
        url: wc?.getURL() ?? url ?? '',
        active: true,
        owner,
      }
    },

    async closeTab(tabId) {
      const instanceId = instanceIdOf(tabId)
      if (instanceId == null) throw new Error(`Unknown tabId: ${tabId}`)
      const wcId = tabRegistry.get(instanceId)?.wcId
      dropEventListener(tabId, wcId != null ? (webContents.fromId(wcId) ?? undefined) : undefined)
      await askRenderer<void>('closeTab', { instanceId })
      if (wcId != null) downloadGrants.delete(wcId)
      tabRegistry.delete(instanceId)
    },
  }
}

function instanceIdOf(tabId: number): string | null {
  for (const [k, v] of tabRegistry) if (v.wcId === tabId) return k
  return null
}

/** A new tab's webContents only registers once the renderer fires `dom-ready`;
 *  poll until it shows up. */
async function waitForRegistration(instanceId: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const id = tabRegistry.get(instanceId)?.wcId
    if (id != null) return id
    if (Date.now() > deadline) throw new Error(`Tab ${instanceId} did not register within ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Number of currently registered tabs. For tests and debugging. */
export function browserUseTabCount(): number {
  return tabRegistry.size
}

// ---- The global IAB backend ----
// Exactly one, serving every session, in echo mode: `getInfo` reads the caller's
// session_id out of the request and echoes it back, so it matches whichever
// session asked.
//
// It has to exist before the model runs: browser-client never creates a backend,
// it only discovers one by reading the socket directory.
let backend: IabBackend | null = null

/** Called at app startup; idempotent. Returns the socket path, or null on
 *  failure, which must not block startup. */
export async function startIabBackend(): Promise<string | null> {
  if (backend) return backend.path
  try {
    const b = new IabBackend({ driver: createElectronCdpDriver(), name: 'operon' })
    const p = await b.listen()
    backend = b
    console.log(`[browser-use] IAB backend listening: ${p}`)
    return p
  } catch (e) {
    // Browser Use is optional; failing to start it must not take the app down.
    console.error('[browser-use] failed to start IAB backend:', e)
    return null
  }
}

/** Called on app exit. The socket file does not remove itself, and leaving it
 *  behind lets clients discover a dead backend they cannot connect to. */
export async function stopIabBackend(): Promise<void> {
  const b = backend
  backend = null
  await b?.close()
}
