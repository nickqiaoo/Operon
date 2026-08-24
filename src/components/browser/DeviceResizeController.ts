/** On-screen rect of the emulated viewport, in coordinates local to the
 *  body-level webview container that the grips are appended to. */
export interface DeviceFrame {
  /** Webview left edge (container-local px). */
  left: number
  /** Webview top edge (container-local px; usually 0). */
  top: number
  /** Displayed webview width (px). */
  width: number
  /** Displayed webview height (px). */
  height: number
  /** Display scale (displayed px = css px × factor). */
  factor: number
}

interface ControllerOptions {
  /** Current emulated viewport CSS size — basis for the axis a handle leaves alone. */
  getSize: () => { width: number; height: number }
  /** Apply a new emulated viewport CSS size. */
  onResize: (size: { width: number; height: number }) => void
}

type HandleKind = "left" | "right" | "bottom" | "bl" | "br"

const MIN = 80
const clamp = (n: number, max: number): number => Math.max(MIN, Math.min(max, Math.round(n)))

/**
 * Draws Chrome-DevTools-style resize grips on the edges of the emulated viewport
 * (left / right / bottom + the two bottom corners) and lets the user drag to
 * resize it. The viewport is centered horizontally, so width tracks the cursor's
 * distance from the container center (both sides grow together); height is
 * top-anchored.
 *
 * The grips are plain DOM children of the webview container (which lives at body
 * level, outside React), so they track the viewport automatically every time
 * `WebviewInstance.positionVisible` repositions it.
 */
export class DeviceResizeController {
  private readonly container: HTMLElement
  private readonly opts: ControllerOptions
  private readonly handles = new Map<HandleKind, HTMLDivElement>()
  private factor = 1
  private cleanupDrag: (() => void) | null = null

  constructor(container: HTMLElement, opts: ControllerOptions) {
    this.container = container
    this.opts = opts
  }

  /** Position the grips over the given viewport rect, or hide them when null. */
  layout(frame: DeviceFrame | null): void {
    if (frame == null) {
      for (const el of this.handles.values()) el.style.display = "none"
      return
    }
    this.factor = frame.factor
    this.ensureHandles()
    const { left, top, width, height } = frame
    const HIT = 14
    const CORNER = 16
    const place = (k: HandleKind, style: Partial<CSSStyleDeclaration>): void => {
      const el = this.handles.get(k)
      if (el == null) return
      el.style.display = "flex"
      Object.assign(el.style, style)
    }
    place("left", { left: `${left - HIT / 2}px`, top: `${top}px`, width: `${HIT}px`, height: `${height}px` })
    place("right", { left: `${left + width - HIT / 2}px`, top: `${top}px`, width: `${HIT}px`, height: `${height}px` })
    place("bottom", { left: `${left}px`, top: `${top + height - HIT / 2}px`, width: `${width}px`, height: `${HIT}px` })
    place("bl", { left: `${left - CORNER / 2}px`, top: `${top + height - CORNER / 2}px`, width: `${CORNER}px`, height: `${CORNER}px` })
    place("br", { left: `${left + width - CORNER / 2}px`, top: `${top + height - CORNER / 2}px`, width: `${CORNER}px`, height: `${CORNER}px` })
  }

  dispose(): void {
    this.cleanupDrag?.()
    for (const el of this.handles.values()) el.remove()
    this.handles.clear()
  }

  private ensureHandles(): void {
    if (this.handles.size > 0) return
    const make = (kind: HandleKind, cursorCls: string, grip: "v" | "h" | "c"): void => {
      const el = document.createElement("div")
      el.className = `device-resize-handle ${cursorCls}`
      el.style.display = "none"
      const g = document.createElement("div")
      g.className = `device-resize-grip device-resize-grip--${grip}`
      el.append(g)
      el.addEventListener("mousedown", (e) => this.startDrag(kind, e))
      this.container.append(el)
      this.handles.set(kind, el)
    }
    make("left", "device-resize-handle--ew", "v")
    make("right", "device-resize-handle--ew", "v")
    make("bottom", "device-resize-handle--ns", "h")
    make("bl", "device-resize-handle--nesw", "c")
    make("br", "device-resize-handle--nwse", "c")
  }

  private startDrag(kind: HandleKind, e: MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    this.cleanupDrag?.()

    const rect = this.container.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const topY = rect.top
    const factor = this.factor || 1
    // Can't grow past the visible container — the viewport stays inside the panel.
    const maxW = Math.round(rect.width / factor)
    const maxH = Math.round(rect.height / factor)
    const resizesWidth = kind !== "bottom"
    const resizesHeight = kind !== "left" && kind !== "right"

    // Fullscreen capture layer: moves over the <webview> don't reach the host
    // window, so we overlay a transparent div that owns the pointer mid-drag.
    const cursor =
      kind === "bottom" ? "ns-resize"
      : kind === "bl" ? "nesw-resize"
      : kind === "br" ? "nwse-resize"
      : "ew-resize"
    const capture = document.createElement("div")
    capture.style.cssText = `position:fixed;inset:0;z-index:2147483646;cursor:${cursor};`
    document.body.append(capture)

    const onMove = (ev: MouseEvent): void => {
      const cur = this.opts.getSize()
      let { width, height } = cur
      // Centered viewport: width = twice the cursor's distance from center.
      if (resizesWidth) width = clamp((2 * Math.abs(ev.clientX - centerX)) / factor, maxW)
      if (resizesHeight) height = clamp((ev.clientY - topY) / factor, maxH)
      this.opts.onResize({ width, height })
    }
    const onUp = (): void => this.cleanupDrag?.()

    this.cleanupDrag = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      capture.remove()
      this.cleanupDrag = null
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }
}
