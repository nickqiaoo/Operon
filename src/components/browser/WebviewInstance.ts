import type { WebviewTag } from "electron"
import { recordServerVisit } from "./serverHistory"
import {
  BROWSER_RUNTIME_CHANNEL,
  type Anchor,
  type AnchorRect,
  type BrowserRuntimeToGuest,
  type BrowserRuntimeToHost,
  type DesignElementChange,
  type DesignSnapshot,
  type DesignSubmission,
  type PageComment,
} from "@/types/browser-runtime"
import { useEditorStore } from "@/stores/editor-store"
import {
  useAnnotationsStore,
  annotationsForInstance,
  type Annotation,
} from "@/stores/annotations-store"
import { useAnnotationEditorStore } from "@/stores/annotation-editor-store"
import { DeviceResizeController } from "./DeviceResizeController"

export interface WebviewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WebviewSyncOptions {
  /** zoom factor applied to the host window (operon-side). */
  windowZoom?: number
  /** Additional scale on the webview itself (e.g. responsive viewport sim). */
  scale?: number
}

export interface WebviewState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  /** Last navigation failure (errorCode + description). null on success. */
  loadError: { code: number; description: string; url: string } | null
  /** Annotation comment mode active (drives the toolbar toggle). */
  commentMode: boolean
  /** Before/after overlay: design changes applied to the live page. */
  designPreviewAll: boolean
  /** Page zoom factor (1 = 100%). */
  zoom: number
  /** Device-emulation toolbar visible. */
  deviceToolbar: boolean
  /** Emulated viewport size when the device toolbar is on (null = responsive). */
  deviceSize: { width: number; height: number } | null
  /** Live CSS size of the emulated viewport — what the toolbar's fields show
   *  (equals deviceSize when fixed, or the measured fill size when responsive). */
  viewportSize: { width: number; height: number } | null
}

type StateListener = (state: WebviewState) => void

/** Markdown context block describing the annotation target (sent to the agent). */
const formatAnchorContext = (a: Anchor): string => {
  const lines = [
    "**Browser annotation**",
    `- Page: ${a.pageTitle || a.pageUrl} (${a.pageUrl})`,
  ]
  if (a.kind === "region") {
    lines.push(
      `- Region: ${Math.round(a.rect.width)}×${Math.round(a.rect.height)} at (${Math.round(a.rect.x)}, ${Math.round(a.rect.y)})`
    )
  } else {
    lines.push(
      `- Element: \`${a.tagName}\`${a.role ? ` (role=${a.role})` : ""}${a.name ? ` — "${a.name}"` : ""}`
    )
    if (a.selector) lines.push(`- Selector: \`${a.selector}\``)
    if (a.text) lines.push(`- Element text: ${a.text}`)
  }
  return lines.join("\n")
}

/**
 * Markdown describing the requested CSS tweaks (design mode), appended to the
 * anchor context. The user visually edited the element in the browser (the
 * attached screenshot shows the result); the agent's job is to make the same
 * change in the *source*. We give it an actionable CSS block keyed by the
 * element's selector, with each old value kept as a comment. Returns "" when
 * nothing was changed.
 */
const formatDesignContext = (design: DesignSubmission | null, anchor: Anchor): string => {
  if (design == null) return ""
  const selector = anchor.kind === "element" ? anchor.selector : null
  const parts: string[] = []
  if (design.declarations.length > 0) {
    const body = design.declarations
      .map((d) => `  ${d.property}: ${d.value}; /* was ${d.previousValue} */`)
      .join("\n")
    const rule = selector ? `${selector} {\n${body}\n}` : body
    parts.push(
      "The user adjusted this element's styling directly in the browser (the " +
        "screenshot shows the intended result). Apply the equivalent change in " +
        "the source CSS/styles — not as an inline style hack:\n\n```css\n" +
        rule +
        "\n```"
    )
  }
  if (design.text != null) {
    parts.push(
      `Also change the element's text content from "${design.text.previousValue}" to "${design.text.value}".`
    )
  }
  if (parts.length === 0) return ""
  return `\n\n**Design change request**\n${parts.join("\n\n")}`
}

/** All built-in browser tabs share one persistent profile, matching Codex IAB. */
const BROWSER_PARTITION = "persist:operon-browser"
// The webview container lives at body level, so its z-index competes directly
// with the host's body-level portals (Radix dialogs/menus, the full-screen
// pages — all z-50). We sit just below them (40): high enough to paint over the
// in-tree placeholder it overlays, low enough that any host overlay naturally
// covers it via normal stacking. This is why no "hide the webview on overlay"
// hack is needed (cf. Codex, which likewise gives its webview a plain z-index).
const Z_INDEX = "40"
const DETACHED_OPACITY = "0"
const HIDDEN_KEEPALIVE_OPACITY = "0.001"
const DEFAULT_BROWSER_USE_BOUNDS: WebviewBounds = {
  x: 0,
  y: 0,
  width: 1280,
  height: 720,
}

const detachedStyles: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  left: "-10000px",
  top: "0",
  width: "1px",
  height: "1px",
  visibility: "hidden",
  opacity: DETACHED_OPACITY,
  pointerEvents: "none",
  zIndex: Z_INDEX,
}

/**
 * One browser session: a `<webview>` element parked inside a fixed-position
 * container appended to document.body, positioned to overlay a placeholder
 * div in the React tree.
 *
 * Uses the same paint-host states as Codex: visible, 0.001-opacity keepalive,
 * 1×1 detached, plus a temporary capture surface for background screenshots.
 */
export class WebviewInstance {
  readonly instanceId: string
  /**
   * Which conversation's browser this page belongs to (chat id as a string — the
   * same value node_repl uses as its `sessionId`). The browser panel switches with
   * the conversation, so every page has an owner; Browser Use reads it to decide
   * which session may see/claim this tab.
   */
  private readonly owner?: string
  readonly container: HTMLDivElement
  readonly webview: WebviewTag
  private readonly browserUseCursor: HTMLDivElement
  private browserUseViewportSize: { width: number; height: number } | null = null
  private lastVisibleBounds: WebviewBounds | null = null
  private lastSyncOptions: WebviewSyncOptions = {}
  private state: WebviewState
  private readonly listeners = new Set<StateListener>()
  private disposed = false
  /** Unsubscribe from the annotations store (pins derive from it). */
  private unsubAnnotations: (() => void) | null = null
  /** Last pin set pushed to the guest — to skip redundant re-syncs. */
  private lastPinKey = ""
  /** Draggable edge grips for the device-emulation viewport. */
  private readonly deviceResize: DeviceResizeController

  constructor({
    instanceId,
    initialUrl,
    owner,
  }: {
    instanceId: string
    initialUrl: string
    owner?: string
  }) {
    this.instanceId = instanceId
    this.owner = owner
    this.state = {
      url: initialUrl,
      title: initialUrl,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      loadError: null,
      commentMode: false,
      designPreviewAll: false,
      zoom: 1,
      deviceToolbar: false,
      deviceSize: null,
      viewportSize: null,
    }

    this.container = document.createElement("div")
    this.container.dataset.browserInstanceId = instanceId
    Object.assign(this.container.style, detachedStyles)

    this.deviceResize = new DeviceResizeController(this.container, {
      getSize: () => this.emulatedCssSize(),
      onResize: (size) => this.setDeviceSize(size),
    })

    this.webview = document.createElement("webview") as WebviewTag
    this.webview.style.cssText = "height:100%;width:100%;background-color:#fff;"
    // partition MUST be set before the webview is attached / loads, per
    // Electron docs.
    this.webview.setAttribute(
      "partition",
      BROWSER_PARTITION
    )

    // Order matters in some Electron versions: attach to live DOM first,
    // wire events second, set src last (so we don't miss the very first
    // did-fail-load / dom-ready events).
    this.browserUseCursor = document.createElement("div")
    this.browserUseCursor.dataset.browserUseCursor = ""
    Object.assign(this.browserUseCursor.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "18px",
      height: "24px",
      display: "none",
      pointerEvents: "none",
      zIndex: "2147483647",
      background: "white",
      clipPath: "polygon(0 0, 0 21px, 5px 16px, 9px 24px, 13px 22px, 9px 14px, 16px 14px)",
      filter: "drop-shadow(0 0 1px rgba(0,0,0,.9)) drop-shadow(0 1px 2px rgba(0,0,0,.45))",
      transform: "translate3d(-2px, -2px, 0)",
      transformOrigin: "top left",
    } satisfies Partial<CSSStyleDeclaration>)

    this.container.append(this.webview, this.browserUseCursor)
    document.body.append(this.container)
    this.wireWebviewEvents()
    this.webview.setAttribute("src", initialUrl)

    // Pins derive from the annotations store: any add/remove/clear (from the
    // page, the chat list, or the toolbar) re-syncs the on-page pins. This is
    // what keeps the page and the chat in lockstep.
    this.unsubAnnotations = useAnnotationsStore.subscribe(() => this.syncPins())
  }

  /** Annotations owned by this browser tab (pin order). */
  private myAnnotations(): Annotation[] {
    return annotationsForInstance(useAnnotationsStore.getState().items, this.instanceId)
  }

  /** Push the current annotations to the guest as pins (deduped). */
  private syncPins(force = false): void {
    if (this.disposed) return
    const annotations = this.myAnnotations()
    const comments: PageComment[] = annotations.map((a, i) => ({
      id: a.id,
      index: i + 1,
      text: a.comment,
      anchor: a.anchor,
    }))
    const key = comments.map((c) => `${c.id}:${c.index}`).join("|")
    if (force || key !== this.lastPinKey) {
      this.lastPinKey = key
      this.sendToGuest({ type: "sync-comments", comments })
    }
    // Keep the before/after overlay in sync with the annotation set.
    if (this.state.designPreviewAll) this.pushDesignOverlay()
  }

  /** Element design changes for the before/after overlay. */
  private designChanges(): DesignElementChange[] {
    const out: DesignElementChange[] = []
    for (const a of this.myAnnotations()) {
      if (a.design == null || a.anchor.kind !== "element" || !a.anchor.selector) continue
      if (a.design.declarations.length === 0 && a.design.text == null) continue
      out.push({
        selector: a.anchor.selector,
        declarations: a.design.declarations,
        text: a.design.text,
      })
    }
    return out
  }

  private pushDesignOverlay(): void {
    this.sendToGuest({ type: "design-show-all", changes: this.designChanges() })
  }

  /** Toggle the before/after overlay (all submitted design changes on the page). */
  setDesignPreviewAll(on: boolean): void {
    if (this.disposed) return
    this.updateState({ designPreviewAll: on })
    if (on) this.pushDesignOverlay()
    else this.sendToGuest({ type: "design-hide-all" })
  }

  /** Render the webview overlaid on the given on-screen bounds. */
  positionVisible(bounds: WebviewBounds, opts: WebviewSyncOptions = {}): void {
    if (this.disposed) return
    if (bounds.width <= 0 || bounds.height <= 0) {
      this.positionHidden()
      return
    }
    this.lastVisibleBounds = bounds
    this.lastSyncOptions = opts
    const scale = opts.scale ?? 1
    const zoom = opts.windowZoom ?? 1
    const factor = scale * zoom
    // The container fills the placeholder area. In device mode it becomes a dark
    // letterbox backdrop and the webview shrinks to the emulated size, centered.
    const device =
      this.browserUseViewportSize ??
      (this.state.deviceToolbar ? this.state.deviceSize : null)
    Object.assign(this.container.style, {
      position: "fixed",
      left: `${bounds.x * zoom}px`,
      top: `${bounds.y * zoom}px`,
      width: `${Math.round(bounds.width * factor)}px`,
      height: `${Math.round(bounds.height * factor)}px`,
      visibility: "visible",
      opacity: "1",
      pointerEvents: "auto",
      zIndex: Z_INDEX,
      transform: "",
      contain: "",
      display: device != null ? "flex" : "block",
      alignItems: device != null ? "flex-start" : "",
      justifyContent: device != null ? "center" : "",
      background: device != null ? "rgba(0,0,0,0.18)" : "",
      overflow: device != null ? "auto" : "",
    } satisfies Partial<CSSStyleDeclaration>)
    if (device != null) {
      Object.assign(this.webview.style, {
        width: `${device.width}px`,
        height: `${device.height}px`,
        flex: "0 0 auto",
        transform: factor === 1 ? "" : `scale(${factor})`,
        transformOrigin: "top center",
      } satisfies Partial<CSSStyleDeclaration>)
    } else {
      Object.assign(this.webview.style, {
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
        flex: "",
        transform: factor === 1 ? "" : `scale(${factor})`,
        transformOrigin: "top left",
      } satisfies Partial<CSSStyleDeclaration>)
    }

    // Device-emulation: draw the resize grips over the viewport edges and keep
    // the toolbar's live size readout in sync. When responsive (device == null)
    // the viewport fills the container, so the grips sit on the container edges.
    if (this.state.deviceToolbar) {
      const containerW = Math.round(bounds.width * factor)
      const containerH = Math.round(bounds.height * factor)
      const dispW = device != null ? device.width * factor : containerW
      const dispH = device != null ? device.height * factor : containerH
      const left = device != null ? (containerW - dispW) / 2 : 0
      this.deviceResize.layout({ left, top: 0, width: dispW, height: dispH, factor })
      const css =
        device != null
          ? { width: device.width, height: device.height }
          : { width: Math.round(bounds.width), height: Math.round(bounds.height) }
      if (
        this.state.viewportSize?.width !== css.width ||
        this.state.viewportSize?.height !== css.height
      ) {
        this.updateState({ viewportSize: css })
      }
    } else {
      this.deviceResize.layout(null)
    }
  }

  /** Current emulated viewport CSS size (deviceSize, or the measured fill size). */
  private emulatedCssSize(): { width: number; height: number } {
    const d = this.state.deviceSize
    if (d != null) return d
    const b = this.lastVisibleBounds
    return {
      width: Math.round(b?.width ?? 0) || 1280,
      height: Math.round(b?.height ?? 0) || 800,
    }
  }

  /**
   * Hide the webview but keep the webContents alive. Uses opacity 0.001 +
   * pointer-events:none rather than display:none so Chromium keeps rendering
   * (which preserves scroll position, JS state, video playback).
   */
  positionHidden(): void {
    if (this.disposed) return
    const last = this.lastVisibleBounds ?? DEFAULT_BROWSER_USE_BOUNDS
    const bounds = this.browserUseViewportSize == null
      ? last
      : { ...last, width: this.browserUseViewportSize.width, height: this.browserUseViewportSize.height }
    Object.assign(this.container.style, {
      position: "fixed",
      left: `${bounds.x}px`,
      top: `${bounds.y}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
      visibility: "visible",
      opacity: HIDDEN_KEEPALIVE_OPACITY,
      pointerEvents: "none",
      zIndex: Z_INDEX,
      contain: "layout paint size style",
      transform: "translate3d(0, 0, 0)",
    } satisfies Partial<CSSStyleDeclaration>)
  }

  /**
   * Give a parked guest a real paint surface for CDP full-page/cropped screenshots.
   *
   * This deliberately changes DOM geometry instead of using
   * `Emulation.setDeviceMetricsOverride`: Chromium will not produce a frame for an
   * invisible 1×1 guest just because its reported viewport numbers changed.
   * Mirrors Codex's capture host: visible + opacity 0.001 + requested CSS size.
   */
  positionCaptureSurface(size: { width: number; height: number }): void {
    if (this.disposed) return
    const width = Math.max(1, Math.ceil(size.width))
    const height = Math.max(1, Math.ceil(size.height))
    Object.assign(this.container.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      width: `${width}px`,
      height: `${height}px`,
      visibility: "visible",
      opacity: HIDDEN_KEEPALIVE_OPACITY,
      pointerEvents: "none",
      zIndex: Z_INDEX,
      contain: "layout paint size style",
      transform: "translate3d(0, 0, 0)",
      transformOrigin: "",
      display: "block",
      alignItems: "",
      justifyContent: "",
      background: "",
      overflow: "",
    } satisfies Partial<CSSStyleDeclaration>)
    Object.assign(this.webview.style, {
      width: "100%",
      height: "100%",
      flex: "",
      transform: "",
      transformOrigin: "",
    } satisfies Partial<CSSStyleDeclaration>)
    this.deviceResize.layout(null)
  }

  /** Move completely off-screen — used when the tab is inactive or panel closed. */
  positionDetached(): void {
    if (this.disposed) return
    Object.assign(this.container.style, detachedStyles)
  }

  setBrowserUseCursor(cursor: { x: number; y: number } | null): void {
    if (this.disposed) return
    if (cursor == null) {
      this.browserUseCursor.style.display = "none"
      return
    }
    this.browserUseCursor.style.display = "block"
    this.browserUseCursor.style.transform =
      `translate3d(${cursor.x - 2}px, ${cursor.y - 2}px, 0)`
  }

  setBrowserUseViewport(size: { width: number; height: number } | null): void {
    if (this.disposed) return
    this.browserUseViewportSize = size
  }

  navigate(url: string): void {
    if (this.disposed) return
    // The webview may not be attached / dom-ready yet (e.g. created with an
    // empty src for the landing page). isLoading()/stop() throw in that state,
    // but assigning `src` always works — so guard the pre-stop and load anyway.
    try {
      if (this.webview.isLoading?.()) this.webview.stop?.()
    } catch {
      // not ready — nothing to stop
    }
    // Clear last error, and set the url optimistically so the landing page
    // hides immediately on click (did-navigate confirms/corrects it later).
    this.updateState({ loadError: null, url })
    this.webview.src = url
  }

  back(): void {
    if (this.disposed) return
    try {
      if (this.webview.canGoBack?.()) this.webview.goBack()
    } catch {
      // webview not ready
    }
  }

  forward(): void {
    if (this.disposed) return
    try {
      if (this.webview.canGoForward?.()) this.webview.goForward()
    } catch {
      // webview not ready
    }
  }

  reload(): void {
    if (this.disposed) return
    try {
      this.webview.reload()
    } catch {
      // webview not ready
    }
  }

  /** Force reload, bypassing the HTTP cache. */
  forceReload(): void {
    if (this.disposed) return
    try {
      this.webview.reloadIgnoringCache()
    } catch {
      // webview not ready
    }
  }

  /** Capture the visible page and copy it to the OS clipboard. */
  async screenshotToClipboard(): Promise<boolean> {
    if (this.disposed) return false
    try {
      const image = await this.webview.capturePage()
      if (image.isEmpty()) return false
      return (await window.electronAPI?.browser?.screenshotToClipboard(image.toDataURL())) ?? false
    } catch {
      return false
    }
  }

  /** Clear cookies and/or cache for the shared built-in-browser profile. */
  async clearData(kinds: Array<"cookies" | "cache">): Promise<void> {
    await window.electronAPI?.browser?.clearData(BROWSER_PARTITION, kinds)
  }

  /** Set the page zoom factor (1 = 100%), clamped to a sane range. */
  setZoom(factor: number): void {
    if (this.disposed) return
    const z = Math.min(3, Math.max(0.25, factor))
    try {
      this.webview.setZoomFactor(z)
    } catch {
      // webview not ready
    }
    this.updateState({ zoom: z })
  }

  /** Toggle the device-emulation toolbar (resizes the webview to a fixed size). */
  setDeviceToolbar(on: boolean): void {
    if (this.disposed) return
    this.updateState({ deviceToolbar: on, deviceSize: on ? this.state.deviceSize : null })
    this.reapplyBounds()
  }

  /** Set the emulated viewport size (null = responsive / fill). */
  setDeviceSize(size: { width: number; height: number } | null): void {
    if (this.disposed) return
    this.updateState({ deviceSize: size })
    this.reapplyBounds()
  }

  /** Swap width/height (rotate the emulated device). */
  rotateDevice(): void {
    const s = this.state.deviceSize
    if (s == null) return
    this.setDeviceSize({ width: s.height, height: s.width })
  }

  /** Re-run positioning with the last bounds (after a device-size change). */
  private reapplyBounds(): void {
    if (this.lastVisibleBounds != null) {
      this.positionVisible(this.lastVisibleBounds, this.lastSyncOptions)
    }
  }

  stop(): void {
    if (this.disposed) return
    try {
      this.webview.stop?.()
    } catch {
      // webview not ready
    }
  }

  /** Send a message down into the in-webview runtime (guest preload). */
  sendToGuest(msg: BrowserRuntimeToGuest): void {
    if (this.disposed) return
    try {
      this.webview.send(BROWSER_RUNTIME_CHANNEL, msg)
    } catch {
      // webview not attached yet — runtime not reachable
    }
  }

  /** Toggle annotation comment mode (optimistic; guest confirms via events). */
  setCommentMode(on: boolean): void {
    if (this.disposed) return
    this.updateState({ commentMode: on })
    this.sendToGuest({ type: "set-mode", mode: on ? "comment" : "browse" })
  }

  getState(): WebviewState {
    return this.state
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // Drop the Browser Use CDP registration (main keeps a defensive staleness
    // check too, since this can't be guaranteed to arrive).
    try {
      window.electronAPI?.browser?.unregisterTab(this.instanceId)
    } catch {
      // ignore
    }
    this.unsubAnnotations?.()
    this.unsubAnnotations = null
    this.deviceResize.dispose()
    this.listeners.clear()
    try {
      this.container.remove()
    } catch {
      // ignore
    }
  }

  // ------------------------------------------------------------------------

  private handleRuntimeMessage(msg: BrowserRuntimeToHost): void {
    switch (msg.type) {
      case "ready":
        // Re-assert mode + re-send pins after a navigation (the fresh guest
        // starts in browse with no comments). Unresolvable pins simply hide,
        // so this naturally no-ops on a different page and re-shows on return.
        if (this.state.commentMode) this.sendToGuest({ type: "set-mode", mode: "comment" })
        // Fresh guest has no pins — force a re-push of our annotations.
        this.syncPins(true)
        break
      case "pong":
        break
      case "mode-changed":
        // Guest toggled mode itself (e.g. Escape) — sync the toolbar.
        this.updateState({ commentMode: msg.mode === "comment" })
        break
      case "open-editor":
        this.handleOpenEditor(msg.anchor, msg.viewportRect, msg.design, msg.editId)
        break
      case "comment-submitted":
        void this.handleCommentSubmitted(msg.anchor, msg.text, msg.design)
        break
      case "comment-cancelled":
        break
    }
  }

  /** Open the child-window editor positioned over the annotated target. */
  private handleOpenEditor(
    anchor: Anchor,
    viewportRect: AnchorRect,
    design: DesignSnapshot | null,
    editId?: string
  ): void {
    const bounds = this.lastVisibleBounds
    if (bounds == null) return
    // Editing an existing pin: pre-fill its comment + prior design so the user
    // tweaks rather than starts over, and update that annotation on submit.
    const existing =
      editId != null
        ? useAnnotationsStore.getState().items.find((a) => a.id === editId) ?? null
        : null
    // Target top-left → screen coords: the renderer content origin
    // (window.screenX/Y) + the webview's offset in the window (bounds) + the
    // target's offset within the webview viewport. (Assumes window zoom = 1.)
    useAnnotationEditorStore.getState().open({
      screen: {
        x: window.screenX + bounds.x + viewportRect.x,
        y: window.screenY + bounds.y + viewportRect.y,
      },
      targetHeight: viewportRect.height,
      targetLabel: anchor.kind === "element" ? anchor.tagName : "region",
      design,
      initialText: existing?.comment ?? "",
      initialDesign: existing?.design ?? null,
      onDesignChange: (declarations, text) => {
        this.sendToGuest({ type: "design-preview", declarations, text })
      },
      onSubmit: ({ text, design: submission }) => {
        void this.handleCommentSubmitted(anchor, text, submission, editId)
      },
      onCancel: () => {
        this.sendToGuest({ type: "capture-done" }) // clear highlight + revert preview
      },
    })
  }

  /**
   * A comment was submitted (from the child-window editor): capture the full
   * viewport (element still highlighted in the guest), show it as a pin, and
   * queue it (tagged with the active workspace) for the chat composer. Mirrors
   * codex — agent gets screenshot + context + text.
   */
  private async handleCommentSubmitted(
    anchor: Anchor,
    text: string,
    design: DesignSubmission | null,
    editId?: string
  ): Promise<void> {
    // Capture the full viewport — the design preview is still applied in the
    // guest, so the screenshot shows the requested result. Like codex, the
    // agent gets the whole page for context, not a cropped element.
    let screenshotDataUrl: string | null = null
    try {
      const image = await this.webview.capturePage()
      if (!image.isEmpty()) screenshotDataUrl = image.toDataURL()
    } catch {
      // capturePage unavailable / webview not painted — fall back to text-only
    }
    // Let the guest clear the highlight + revert the preview now that the
    // screenshot is taken.
    this.sendToGuest({ type: "capture-done" })
    if (this.disposed) return
    // Editing reuses the existing id (keeps pin order); new ones get a fresh id.
    const id =
      editId ??
      (typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    // Upsert into the single source of truth — the store subscription re-syncs
    // the on-page pin, and the chat list (filtered by workspace) picks it up too.
    useAnnotationsStore.getState().upsert({
      id,
      instanceId: this.instanceId,
      workspaceId: useEditorStore.getState().currentWorkspaceId,
      anchor,
      comment: text,
      design,
      context: formatAnchorContext(anchor) + formatDesignContext(design, anchor),
      screenshotDataUrl,
      createdAt: Date.now(),
    })
  }

  private updateState(patch: Partial<WebviewState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }

  private wireWebviewEvents(): void {
    // Register this tab's webContents with the main process so the Browser Use
    // IAB backend can drive it over CDP (electron/browser-use-driver.ts).
    // Must happen renderer-side: <webview> is created here, and the main process
    // has no way to map a guest webContents back to our instanceId.
    //
    // `did-attach` (not `dom-ready`): a tab opened with an empty URL sits on the
    // local-servers landing page and never loads a guest page, so it never fires
    // `dom-ready` — registering there leaves those tabs invisible to Browser Use.
    // `did-attach` fires as soon as the guest is attached, which is also the point
    // getWebContentsId() becomes valid. `dom-ready` stays as a cheap re-register in
    // case did-attach was missed; registration is idempotent (a Map set).
    const register = () => {
      try {
        window.electronAPI?.browser?.registerTab(
          this.instanceId,
          this.webview.getWebContentsId(),
          this.owner
        )
      } catch {
        // Browser Use is optional; never let registration break the browser.
      }
    }
    this.webview.addEventListener("did-attach", register)
    this.webview.addEventListener("dom-ready", register)

    this.webview.addEventListener("did-start-loading", () =>
      this.updateState({ isLoading: true })
    )
    this.webview.addEventListener("did-stop-loading", () =>
      this.updateState({
        isLoading: false,
        canGoBack: this.webview.canGoBack?.() ?? false,
        canGoForward: this.webview.canGoForward?.() ?? false,
      })
    )
    this.webview.addEventListener("did-navigate", (event) => {
      this.updateState({
        url: event.url,
        loadError: null,
        canGoBack: this.webview.canGoBack?.() ?? false,
        canGoForward: this.webview.canGoForward?.() ?? false,
      })
      // Remember loopback addresses the user lands on; the title fills in via
      // page-title-updated a moment later. (No-op for non-local URLs.)
      recordServerVisit(event.url)
    })
    this.webview.addEventListener("did-navigate-in-page", (event) => {
      this.updateState({ url: event.url })
    })
    this.webview.addEventListener("page-title-updated", (event) => {
      this.updateState({ title: event.title || this.state.url })
      recordServerVisit(this.state.url, event.title)
    })

    // Top-level navigation failures. `isMainFrame` distinguishes from
    // sub-frame failures we don't care about. errorCode -3 is ABORTED which
    // happens during normal navigation cancellation — ignore it.
    this.webview.addEventListener("did-fail-load", (event) => {
      const failEvent = event as Electron.DidFailLoadEvent
      if (failEvent.isMainFrame !== true) return
      if (failEvent.errorCode === -3) return
      console.warn(
        "[WebviewInstance] did-fail-load",
        this.instanceId,
        failEvent.errorCode,
        failEvent.errorDescription,
        failEvent.validatedURL
      )
      this.updateState({
        isLoading: false,
        loadError: {
          code: failEvent.errorCode,
          description: failEvent.errorDescription,
          url: failEvent.validatedURL,
        },
      })
    })

    // Messages from the in-webview runtime (guest preload). Phase 1: log the
    // round-trip and answer `ready` with a `ping` to prove both directions.
    this.webview.addEventListener("ipc-message", (event) => {
      if (event.channel !== BROWSER_RUNTIME_CHANNEL) return
      const msg = event.args[0] as BrowserRuntimeToHost
      this.handleRuntimeMessage(msg)
    })

    // Mirror guest console output to host devtools — invaluable for diagnosing
    // load failures and CSP issues.
    this.webview.addEventListener("console-message", (event) => {
      const msg = event as Electron.ConsoleMessageEvent
      const tag = `[webview:${this.instanceId}]`
      // Level 0=verbose, 1=info, 2=warning, 3=error.
      if (msg.level >= 3) {
        console.error(tag, msg.message)
      } else if (msg.level === 2) {
        console.warn(tag, msg.message)
      }
    })
  }
}
