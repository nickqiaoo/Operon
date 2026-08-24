/**
 * Preload injected into the browser sidebar's `<webview>` guest pages (wired in
 * the main process via `will-attach-webview`). Runs in the guest's isolated
 * world — it can use `ipcRenderer` AND touch the page DOM (contextIsolation
 * isolates the JS context, not the DOM/event system).
 *
 * Implements the annotation *capture* layer (no React — plain DOM in a Shadow
 * root): comment-mode toggle, capture-phase event interception, element
 * hit-test + selector, hover highlight, and an inline comment editor. On submit
 * it sends the anchor + text up to the host.
 */
import { ipcRenderer } from "electron"
import {
  BROWSER_RUNTIME_CHANNEL,
  type Anchor,
  type BrowserInteractionMode,
  type BrowserRuntimeToGuest,
  type BrowserRuntimeToHost,
  type DesignDeclaration,
  type DesignElementChange,
  type DesignSnapshot,
  type DesignText,
  type ElementAnchor,
  type PageComment,
  type RegionAnchor,
} from "../src/types/browser-runtime.ts"

/** A viewport-space rectangle (CSS px), used for the highlight + drag box. */
interface Box {
  left: number
  top: number
  width: number
  height: number
}

const sendToHost = (msg: BrowserRuntimeToHost): void => {
  ipcRenderer.sendToHost(BROWSER_RUNTIME_CHANNEL, msg)
}

// ---------------------------------------------------------------------------
// Selector + hit-test (spec §4)
// ---------------------------------------------------------------------------

const cssEscape = (value: string): string =>
  typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")

const isRenderedElement = (el: Element): boolean => {
  const r = el.getBoundingClientRect()
  return r.width > 0 || r.height > 0
}

/** ≤4 ancestors: id wins outright, else tag.class + :nth-of-type among siblings. */
const computeSelector = (start: Element): string | null => {
  const parts: string[] = []
  let node: Element | null = start
  let depth = 0
  while (node && depth < 4) {
    const tag = node.tagName.toLowerCase()
    if (node.id) {
      parts.unshift(`${tag}#${cssEscape(node.id)}`)
      return parts.join(" > ")
    }
    let sel = tag
    const classes = Array.from(node.classList)
      .filter((c) => /^[a-zA-Z0-9_-]+$/.test(c))
      .slice(0, 2)
    if (classes.length > 0) sel += `.${classes.map(cssEscape).join(".")}`
    const parent: Element | null = node.parentElement
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (c) => isRenderedElement(c) && c.tagName === node!.tagName
      )
      if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(node) + 1})`
    }
    parts.unshift(sel)
    node = parent
    depth += 1
  }
  return parts.length > 0 ? parts.join(" > ") : null
}

const isFixedElement = (start: Element): boolean => {
  let node: Element | null = start
  while (node && node !== document.body) {
    const pos = getComputedStyle(node).position
    if (pos === "fixed" || pos === "sticky") return true
    node = node.parentElement
  }
  return false
}

const trimmedText = (el: Element): string | null => {
  const t = (el.textContent ?? "").replace(/\s+/g, " ").trim()
  return t.length === 0 ? null : t.slice(0, 200)
}

const buildAnchor = (el: Element, point: { x: number; y: number }): ElementAnchor => {
  const rect = el.getBoundingClientRect()
  const fixed = isFixedElement(el)
  const text = trimmedText(el)
  return {
    kind: "element",
    selector: computeSelector(el),
    tagName: el.tagName.toLowerCase(),
    role: el.getAttribute("role"),
    name: el.getAttribute("aria-label") ?? el.getAttribute("title") ?? text,
    text,
    rect: {
      x: rect.left + (fixed ? 0 : window.scrollX),
      y: rect.top + (fixed ? 0 : window.scrollY),
      width: rect.width,
      height: rect.height,
    },
    point: {
      xPercent: window.innerWidth > 0 ? (point.x / window.innerWidth) * 100 : 0,
      y: point.y + (fixed ? 0 : window.scrollY),
    },
    isFixed: fixed,
    pageUrl: location.href,
    pageTitle: document.title,
  }
}

/** Build a region anchor from a viewport-space drag box (→ document coords). */
const buildRegionAnchor = (box: Box): RegionAnchor => ({
  kind: "region",
  rect: {
    x: box.left + window.scrollX,
    y: box.top + window.scrollY,
    width: box.width,
    height: box.height,
  },
  pageUrl: location.href,
  pageTitle: document.title,
})

// ---------------------------------------------------------------------------
// Overlay (plain DOM in a Shadow root, spec §2/§7)
// ---------------------------------------------------------------------------

const OVERLAY_HOST_ID = "operon-annotation-overlay"
const Z_TOP = "2147483647"

interface Overlay {
  host: HTMLElement
  shadow: ShadowRoot
  highlight: HTMLElement
}
let overlay: Overlay | null = null

const ensureOverlay = (): Overlay => {
  if (overlay) return overlay
  const host = document.createElement("div")
  host.id = OVERLAY_HOST_ID
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: Z_TOP,
  } satisfies Partial<CSSStyleDeclaration>)
  const shadow = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = `
    :host, * { box-sizing: border-box; }
    .highlight {
      position: absolute; pointer-events: none;
      border: 2px solid rgba(59,130,246,0.9);
      background: rgba(59,130,246,0.12);
      border-radius: 3px;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.4);
      display: none;
    }
    .pin {
      position: absolute; pointer-events: auto; cursor: pointer;
      min-width: 20px; height: 20px; padding: 0 5px;
      display: none; align-items: center; justify-content: center;
      background: rgb(59,130,246); color: #fff;
      font: 600 11px/1 -apple-system, system-ui, sans-serif;
      border-radius: 10px; border: 2px solid #fff;
      box-shadow: 0 1px 4px rgba(0,0,0,0.35);
      transform: translate(-50%, -50%);
      transition: transform 0.1s;
    }
    .pin:hover { transform: translate(-50%, -50%) scale(1.15); }`
  const highlight = document.createElement("div")
  highlight.className = "highlight"
  shadow.append(style, highlight)
  ;(document.documentElement || document.body).appendChild(host)
  overlay = { host, shadow, highlight }
  return overlay
}

const showHighlight = (rect: Box): void => {
  const { highlight } = ensureOverlay()
  Object.assign(highlight.style, {
    display: "block",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  } satisfies Partial<CSSStyleDeclaration>)
}

const hideHighlight = (): void => {
  if (overlay) overlay.highlight.style.display = "none"
}

const destroyOverlay = (): void => {
  overlay?.host.remove()
  overlay = null
  pinEls.clear() // pins lived in the shadow root we just removed
}

// ---------------------------------------------------------------------------
// Comment pins (spec §8) — show submitted comments on the page, follow scroll,
// re-resolve the element from its selector after reload/DOM changes.
// ---------------------------------------------------------------------------

let comments: PageComment[] = []
const pinEls = new Map<string, HTMLElement>()
let detachPinListeners: (() => void) | null = null
let repositionScheduled = false

/**
 * Direct element references for selected elements, keyed by their selector.
 * The selector alone is fragile on dynamic sites (hashed classes, shifting
 * :nth-of-type — e.g. Google), so a freshly-created pin's element often can't be
 * re-resolved by `querySelector` and the pin would vanish. We keep the actual
 * element we captured and prefer it while it's still connected (codex's
 * `resolveElementFromAnchor`), falling back to the selector after a reload.
 */
const capturedElements = new Map<string, Element>()

/** Resolve an element anchor to a live element: cached ref first, then selector. */
const resolveAnchorElement = (selector: string | null): Element | null => {
  if (!selector) return null
  const cached = capturedElements.get(selector)
  if (cached != null && cached.isConnected) return cached
  try {
    return document.querySelector(selector)
  } catch {
    return null
  }
}

/** Viewport-space center for a pin, or null if the anchor can't be resolved. */
const pinCenter = (anchor: Anchor): { x: number; y: number } | null => {
  if (anchor.kind === "region") {
    return {
      x: anchor.rect.x - window.scrollX + anchor.rect.width / 2,
      y: anchor.rect.y - window.scrollY + anchor.rect.height / 2,
    }
  }
  const el = resolveAnchorElement(anchor.selector)
  if (el == null) return null
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

const repositionPins = (): void => {
  for (const comment of comments) {
    const pin = pinEls.get(comment.id)
    if (pin == null) continue
    const center = pinCenter(comment.anchor)
    if (center == null) {
      pin.style.display = "none"
      continue
    }
    // `.pin` has translate(-50%,-50%), so left/top is the center point.
    pin.style.display = "flex"
    pin.style.left = `${center.x}px`
    pin.style.top = `${center.y}px`
  }
}

const scheduleReposition = (): void => {
  if (repositionScheduled) return
  repositionScheduled = true
  requestAnimationFrame(() => {
    repositionScheduled = false
    repositionPins()
  })
}

const attachPinListeners = (): void => {
  if (detachPinListeners) return
  const onChange = () => scheduleReposition()
  document.addEventListener("scroll", onChange, true)
  window.addEventListener("resize", onChange)
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
  })
  detachPinListeners = () => {
    document.removeEventListener("scroll", onChange, true)
    window.removeEventListener("resize", onChange)
    observer.disconnect()
    detachPinListeners = null
  }
}

const renderPins = (): void => {
  const { shadow } = ensureOverlay()
  for (const [id, el] of pinEls) {
    if (!comments.some((c) => c.id === id)) {
      el.remove()
      pinEls.delete(id)
    }
  }
  let pinNumber = 0
  for (const comment of comments) {
    // Region (drag) comments don't get a pin marker — only element ones do.
    if (comment.anchor.kind !== "element") continue
    pinNumber += 1
    let pin = pinEls.get(comment.id)
    if (pin == null) {
      pin = document.createElement("div")
      pin.className = "pin"
      const cid = comment.id
      pin.addEventListener("click", (e) => {
        e.preventDefault()
        e.stopPropagation()
        onPinClick(cid)
      })
      shadow.appendChild(pin)
      pinEls.set(comment.id, pin)
    }
    pin.textContent = String(pinNumber)
  }
  repositionPins()
}

const setComments = (next: PageComment[]): void => {
  comments = next
  if (comments.length > 0) {
    ensureOverlay()
    attachPinListeners()
    renderPins()
  } else {
    detachPinListeners?.()
    for (const el of pinEls.values()) el.remove()
    pinEls.clear()
    if (mode !== "comment") destroyOverlay()
  }
}

// ---------------------------------------------------------------------------
// Design ("adjust") mode (spec §11). On selection the guest snapshots the
// element's tweakable computed styles; while the host design panel is open it
// applies the user's edits live to the element (inline styles + text), then
// reverts on capture-done so the live page isn't left mutated — the requested
// change is sent to the agent, not actually made to the site.
// ---------------------------------------------------------------------------

/** Codex `Pf`: the managed property set captured for every element. */
const BASE_DESIGN_PROPS = [
  "color",
  "background-color",
  "font-size",
  "font-family",
  "font-weight",
  "border-radius",
  "border-color",
  "border-width",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "width",
  "height",
  "opacity",
] as const

/** Codex `Ff`: extra props added when the element is a flex container. */
const FLEX_DESIGN_PROPS = [
  "flex-direction",
  "justify-content",
  "align-items",
  "gap",
  "row-gap",
  "column-gap",
] as const

/** Computed value, falling back to the top side for border shorthands (which
 * read empty from getComputedStyle in Chromium). */
const readComputed = (cs: CSSStyleDeclaration, property: string): string => {
  const v = cs.getPropertyValue(property).trim()
  if (v.length > 0) return v
  if (property === "border-color") return cs.getPropertyValue("border-top-color").trim()
  if (property === "border-width") return cs.getPropertyValue("border-top-width").trim()
  if (property === "border-radius") return cs.getPropertyValue("border-top-left-radius").trim()
  return v
}

/**
 * Editable text of the element, or null. Only leaf elements (text-node children
 * only, no child elements) are editable — applying/reverting a text change via
 * `textContent` would otherwise destroy child elements irrecoverably.
 */
const directText = (el: Element): string | null => {
  const children = Array.from(el.childNodes)
  if (children.some((n) => n.nodeType === Node.ELEMENT_NODE)) return null
  const t = (el.textContent ?? "").replace(/\s+/g, " ").trim()
  return t.length === 0 ? null : t.slice(0, 200)
}

const buildDesignSnapshot = (el: Element): DesignSnapshot | null => {
  if (!(el instanceof HTMLElement)) return null
  const cs = getComputedStyle(el)
  const isFlex = cs.display === "flex" || cs.display === "inline-flex"
  const props = isFlex ? [...BASE_DESIGN_PROPS, ...FLEX_DESIGN_PROPS] : BASE_DESIGN_PROPS
  const declarations: DesignDeclaration[] = props.map((property) => {
    const value = readComputed(cs, property)
    return { property, value, previousValue: value }
  })
  const text = directText(el)
  return {
    declarations,
    text: text == null ? null : { value: text, previousValue: text },
    isFlex,
  }
}

// Live-preview state for the pending element. Originals are stashed lazily so we
// can restore exactly (including "had no inline value" → removeProperty).
let designOriginalInline: Map<string, string> | null = null
let designOriginalText: string | null = null
let designTextApplied = false

const applyDesignPreview = (
  declarations: DesignDeclaration[],
  text: DesignText | null
): void => {
  const el = pendingElement
  if (el == null) return
  if (designOriginalInline == null) designOriginalInline = new Map()
  // Apply the current change set.
  for (const d of declarations) {
    if (!designOriginalInline.has(d.property)) {
      designOriginalInline.set(d.property, el.style.getPropertyValue(d.property))
    }
    el.style.setProperty(d.property, d.value)
  }
  // Restore any property the user reset (no longer in the change set).
  for (const [property, original] of [...designOriginalInline]) {
    if (declarations.some((d) => d.property === property)) continue
    if (original.length > 0) el.style.setProperty(property, original)
    else el.style.removeProperty(property)
    designOriginalInline.delete(property)
  }
  // Text content.
  if (text != null && text.value !== text.previousValue) {
    if (!designTextApplied) {
      designOriginalText = el.textContent
      designTextApplied = true
    }
    if (el.textContent !== text.value) el.textContent = text.value
  } else if (designTextApplied) {
    if (designOriginalText != null) el.textContent = designOriginalText
    designTextApplied = false
    designOriginalText = null
  }
  // Keep the highlight tracking the element as edits resize it.
  showHighlight(el.getBoundingClientRect())
}

const revertDesignPreview = (): void => {
  const el = pendingElement
  if (el != null && designOriginalInline != null) {
    for (const [property, original] of designOriginalInline) {
      if (original.length > 0) el.style.setProperty(property, original)
      else el.style.removeProperty(property)
    }
  }
  if (el != null && designTextApplied && designOriginalText != null) {
    el.textContent = designOriginalText
  }
  designOriginalInline = null
  designTextApplied = false
  designOriginalText = null
}

// ---------------------------------------------------------------------------
// Before/after overlay: persistently apply EVERY submitted design change to its
// element so the page shows the "after". Separate from the edit-time preview
// above (that one targets only the element being edited). Stashes per-element
// originals so we can restore the exact "before".
// ---------------------------------------------------------------------------

interface AppliedDesign {
  el: HTMLElement
  inline: Map<string, string>
  originalText: string | null
  textApplied: boolean
}
let appliedDesigns: AppliedDesign[] = []

const hideAllDesign = (): void => {
  for (const a of appliedDesigns) {
    for (const [property, original] of a.inline) {
      if (original.length > 0) a.el.style.setProperty(property, original)
      else a.el.style.removeProperty(property)
    }
    if (a.textApplied && a.originalText != null) a.el.textContent = a.originalText
  }
  appliedDesigns = []
}

const showAllDesign = (changes: DesignElementChange[]): void => {
  // Always start from a clean slate so re-sends (annotation added/removed) don't
  // double-stash.
  hideAllDesign()
  for (const change of changes) {
    const cached = capturedElements.get(change.selector)
    let el: HTMLElement | null = cached instanceof HTMLElement && cached.isConnected ? cached : null
    if (el == null) {
      try {
        const found = document.querySelector(change.selector)
        el = found instanceof HTMLElement ? found : null
      } catch {
        el = null
      }
    }
    if (el == null) continue
    const inline = new Map<string, string>()
    for (const d of change.declarations) {
      inline.set(d.property, el.style.getPropertyValue(d.property))
      el.style.setProperty(d.property, d.value)
    }
    let originalText: string | null = null
    let textApplied = false
    if (change.text != null && change.text.value !== change.text.previousValue) {
      originalText = el.textContent
      textApplied = true
      el.textContent = change.text.value
    }
    appliedDesigns.push({ el, inline, originalText, textApplied })
  }
}

// ---------------------------------------------------------------------------
// Comment editor (Phase 6: lives in a host child window). The guest just marks
// the target with the highlight, suppresses further clicks while an editor is
// open, and clears the highlight when the host signals capture-done (after
// submit or cancel). The host captures the full viewport while the highlight is
// still shown, then drives the actual comment submission.
// ---------------------------------------------------------------------------

/** Anchor whose editor is currently open in the host child window. */
let pendingAnchor: Anchor | null = null
/** The element the editor is open on (for live design preview); null for regions. */
let pendingElement: HTMLElement | null = null
let editorFallback: number | null = null

const openEditor = (anchor: Anchor, atRect: Box, el: Element | null, editId?: string): void => {
  pendingAnchor = anchor
  pendingElement = el instanceof HTMLElement ? el : null
  // Remember the actual element so its pin can resolve later even if the
  // selector is fragile (see capturedElements).
  if (el != null && anchor.kind === "element" && anchor.selector) {
    capturedElements.set(anchor.selector, el)
  }
  const design = pendingElement != null ? buildDesignSnapshot(pendingElement) : null
  showHighlight(atRect)
  if (editorFallback != null) window.clearTimeout(editorFallback)
  // Safety net in case the host never replies (window closed abnormally, etc.).
  editorFallback = window.setTimeout(clearEditor, 60000)
  sendToHost({
    type: "open-editor",
    anchor,
    viewportRect: {
      x: atRect.left,
      y: atRect.top,
      width: atRect.width,
      height: atRect.height,
    },
    design,
    ...(editId != null ? { editId } : {}),
  })
}

/** Re-open the editor on an existing pin (edit). Host pre-fills + updates it. */
const onPinClick = (id: string): void => {
  const comment = comments.find((c) => c.id === id)
  if (comment == null || comment.anchor.kind !== "element") return
  const el = resolveAnchorElement(comment.anchor.selector)
  if (el == null) return
  const r = el.getBoundingClientRect()
  openEditor(
    comment.anchor,
    { left: r.left, top: r.top, width: r.width, height: r.height },
    el,
    id
  )
}

/** Host finished with the editor (submit captured or cancelled) — release. */
const clearEditor = (): void => {
  if (editorFallback != null) {
    window.clearTimeout(editorFallback)
    editorFallback = null
  }
  revertDesignPreview()
  pendingAnchor = null
  pendingElement = null
  hideHighlight()
}

// ---------------------------------------------------------------------------
// Comment mode + capture-phase event wiring (spec §3)
// ---------------------------------------------------------------------------

let mode: BrowserInteractionMode = "browse"
let detachListeners: (() => void) | null = null

const isInsideOverlay = (ev: Event): boolean =>
  overlay != null && ev.composedPath().includes(overlay.host)

/** The element under (x,y) — overlay is pointer-events:none so it never hits. */
const elementUnder = (x: number, y: number): Element | null => {
  const el = document.elementFromPoint(x, y)
  if (el == null || el.id === OVERLAY_HOST_ID) return null
  return el
}

// Drag-to-select-region state. A press that moves past the threshold becomes a
// region comment; a press that doesn't is treated as an element click.
const DRAG_THRESHOLD = 6
let drag: { startX: number; startY: number; dragging: boolean } | null = null
let suppressClick = false

const boxFrom = (sx: number, sy: number, cx: number, cy: number): Box => ({
  left: Math.min(sx, cx),
  top: Math.min(sy, cy),
  width: Math.abs(cx - sx),
  height: Math.abs(cy - sy),
})

const onMove = (ev: MouseEvent): void => {
  if (mode !== "comment" || pendingAnchor != null || drag != null || isInsideOverlay(ev))
    return
  const el = elementUnder(ev.clientX, ev.clientY)
  if (el == null || el === document.documentElement || el === document.body) {
    hideHighlight()
    return
  }
  showHighlight(el.getBoundingClientRect())
}

const onPointerDown = (ev: PointerEvent): void => {
  if (mode !== "comment" || !ev.isTrusted || isInsideOverlay(ev)) return
  ev.preventDefault()
  ev.stopPropagation()
  if (ev.button !== 0 || pendingAnchor != null) return
  drag = { startX: ev.clientX, startY: ev.clientY, dragging: false }
  hideHighlight()
}

const onPointerMove = (ev: PointerEvent): void => {
  if (drag == null || mode !== "comment") return
  if (!drag.dragging && Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < DRAG_THRESHOLD)
    return
  drag.dragging = true
  ev.preventDefault()
  ev.stopPropagation()
  showHighlight(boxFrom(drag.startX, drag.startY, ev.clientX, ev.clientY))
}

const onPointerUp = (ev: PointerEvent): void => {
  if (drag == null) return
  const wasDragging = drag.dragging
  const box = boxFrom(drag.startX, drag.startY, ev.clientX, ev.clientY)
  drag = null
  if (!wasDragging) return // not a real drag → the click handler makes an element
  ev.preventDefault()
  ev.stopPropagation()
  suppressClick = true // swallow the click that fires right after this drag
  if (pendingAnchor != null) return
  openEditor(buildRegionAnchor(box), box, null)
}

const onPointerCancel = (): void => {
  drag = null
  if (mode === "comment" && pendingAnchor == null) hideHighlight()
}

const onClick = (ev: MouseEvent): void => {
  if (mode !== "comment" || !ev.isTrusted) return
  if (isInsideOverlay(ev)) return // our own editor UI — let it handle the click
  // Swallow the page click (no navigation/submit) regardless.
  ev.preventDefault()
  ev.stopPropagation()
  ev.stopImmediatePropagation()
  if (suppressClick) {
    suppressClick = false // a region drag already handled this gesture
    return
  }
  if (pendingAnchor != null) return // one editor at a time
  const el = elementUnder(ev.clientX, ev.clientY)
  if (el == null) return
  openEditor(buildAnchor(el, { x: ev.clientX, y: ev.clientY }), el.getBoundingClientRect(), el)
}

const onKeyDown = (ev: KeyboardEvent): void => {
  if (mode !== "comment" || ev.key !== "Escape") return
  if (pendingAnchor != null) return // the host child window owns Escape while open
  ev.preventDefault()
  ev.stopPropagation()
  setMode("browse")
  sendToHost({ type: "mode-changed", mode: "browse" })
}

const onScroll = (): void => {
  if (pendingAnchor == null) hideHighlight()
}

const attachListeners = (): void => {
  if (detachListeners) return
  const opts = true // capture phase
  document.addEventListener("mousemove", onMove, opts)
  document.addEventListener("click", onClick, opts)
  document.addEventListener("pointerdown", onPointerDown, opts)
  document.addEventListener("pointermove", onPointerMove, opts)
  document.addEventListener("pointerup", onPointerUp, opts)
  document.addEventListener("pointercancel", onPointerCancel, opts)
  document.addEventListener("keydown", onKeyDown, opts)
  document.addEventListener("scroll", onScroll, opts)
  window.addEventListener("resize", hideHighlight)
  detachListeners = () => {
    document.removeEventListener("mousemove", onMove, opts)
    document.removeEventListener("click", onClick, opts)
    document.removeEventListener("pointerdown", onPointerDown, opts)
    document.removeEventListener("pointermove", onPointerMove, opts)
    document.removeEventListener("pointerup", onPointerUp, opts)
    document.removeEventListener("pointercancel", onPointerCancel, opts)
    document.removeEventListener("keydown", onKeyDown, opts)
    document.removeEventListener("scroll", onScroll, opts)
    window.removeEventListener("resize", hideHighlight)
    detachListeners = null
  }
}

const setMode = (next: BrowserInteractionMode): void => {
  if (mode === next) return
  mode = next
  if (next === "comment") {
    ensureOverlay()
    attachListeners()
  } else {
    clearEditor()
    detachListeners?.()
    hideHighlight()
    drag = null
    suppressClick = false
    // Keep the overlay alive if there are pins to keep showing in browse mode.
    if (comments.length === 0) destroyOverlay()
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

ipcRenderer.on(BROWSER_RUNTIME_CHANNEL, (_event, msg: BrowserRuntimeToGuest) => {
  switch (msg.type) {
    case "ping":
      sendToHost({ type: "pong", receivedAt: Date.now() })
      break
    case "set-mode":
      setMode(msg.mode)
      break
    case "capture-done":
      clearEditor()
      break
    case "sync-comments":
      setComments(msg.comments)
      break
    case "design-preview":
      applyDesignPreview(msg.declarations, msg.text)
      break
    case "design-show-all":
      showAllDesign(msg.changes)
      break
    case "design-hide-all":
      hideAllDesign()
      break
  }
})

const announce = (): void => sendToHost({ type: "ready", url: location.href })
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", announce, { once: true })
} else {
  announce()
}
