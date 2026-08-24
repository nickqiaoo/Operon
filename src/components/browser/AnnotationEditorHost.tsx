import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Check, GripVertical, SlidersHorizontal } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAnnotationEditorStore } from "@/stores/annotation-editor-store"
import type { AnnotationEditorRequest } from "@/stores/annotation-editor-store"
import type { DesignDeclaration, DesignSubmission, DesignText } from "@/types/browser-runtime"
import { AnnotationDesignPanel } from "./AnnotationDesignPanel"

const WIDTH = 360
const PILL_HEIGHT = 56
const DESIGN_HEIGHT = 480
const GAP = 4

/**
 * Renders the annotation editor in a frameless child window floating over the
 * page element (codex-style, Phase 6). Mounted once at the app root.
 *
 * The window is `window.open('about:blank')` — same-origin, same renderer
 * process — so we can copy the app's stylesheets into it and React-portal our
 * editor card in, getting the real shadcn look. `main.ts`'s
 * `setWindowOpenHandler` makes the window frameless + width-locked-resizable.
 *
 * When the target has a tweakable-styles snapshot the card offers the design
 * ("adjust") panel: toggling it grows the window and streams live edits back to
 * the guest for preview; submit sends the requested CSS changes to the agent.
 */
export function AnnotationEditorHost() {
  const request = useAnnotationEditorStore((s) => s.request)
  const close = useAnnotationEditorStore((s) => s.close)
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null)
  const requestRef = useRef(request)
  requestRef.current = request
  const winRef = useRef<Window | null>(null)
  const [text, setText] = useState("")
  const [panelOpen, setPanelOpen] = useState(false)
  const panelOpenRef = useRef(panelOpen)
  panelOpenRef.current = panelOpen
  // Light-dismiss guard: true once the reveal's focus change has settled.
  const settledRef = useRef(false)
  // Latest design diff streamed from the panel (also forwarded for live preview).
  const designRef = useRef<DesignSubmission | null>(null)
  const [hasDesign, setHasDesign] = useState(false)

  /** Where the window should sit for a given height, clamping below/above the target. */
  const computeBounds = useCallback((req: AnnotationEditorRequest, height: number) => {
    const left = Math.round(req.screen.x)
    // availTop/availLeft are non-standard (multi-monitor work area offset).
    const availTop = (window.screen as { availTop?: number }).availTop ?? 0
    const availBottom = availTop + window.screen.availHeight
    let top = Math.round(req.screen.y + req.targetHeight + GAP)
    if (top + height > availBottom) {
      // Not enough room below — place above the target instead.
      top = Math.max(availTop, Math.round(req.screen.y - height - GAP))
    }
    return { left, top }
  }, [])

  /**
   * Create the ONE persistent editor window (kept hidden between uses). Reusing
   * a single window — rather than window.open per annotation — is what kills the
   * flash: nothing is created (and thus shown at the wrong spot) per click. Main
   * drives position + reveal / hide over IPC.
   */
  const ensureWindow = useCallback((): Window | null => {
    if (winRef.current != null && !winRef.current.closed) return winRef.current
    const win = window.open("about:blank", "operon-annotation-editor", `popup=yes,width=${WIDTH},height=${PILL_HEIGHT}`)
    if (win == null) return null
    winRef.current = win
    const doc = win.document
    doc.title = "Annotation"
    // Carry the app's styles into the child document so the portaled shadcn
    // components render with the right theme.
    for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
      doc.head.appendChild(node.cloneNode(true))
    }
    doc.documentElement.className = document.documentElement.className
    Object.assign(doc.documentElement.style, { background: "transparent" })
    Object.assign(doc.body.style, { margin: "0", overflow: "hidden", background: "transparent" })
    const root = doc.createElement("div")
    doc.body.appendChild(root)
    setMountNode(root)
    // Light dismiss: clicking outside blurs the editor → cancel. Guarded so the
    // focus-bounce on reveal doesn't self-close, skipped while the design panel
    // is open (native pickers steal focus), and ignored when no editor is active.
    win.addEventListener("blur", () => {
      if (!settledRef.current || panelOpenRef.current || requestRef.current == null) return
      requestRef.current.onCancel()
      close()
    })
    win.addEventListener("beforeunload", () => {
      winRef.current = null
      setMountNode(null)
    })
    return win
  }, [close])

  // Reveal the editor when a request arrives; hide it when cleared. Reuses the
  // persistent window (no per-click creation → no flash).
  useEffect(() => {
    const api = window.electronAPI?.annotationEditor
    if (request == null) {
      api?.hide()
      return
    }
    const win = ensureWindow()
    if (win == null) {
      close()
      return
    }
    // Reset content for the new target (pre-filled when editing an existing pin).
    setText(request.initialText ?? "")
    setPanelOpen(false)
    designRef.current = request.initialDesign ?? null
    setHasDesign(request.initialDesign != null)
    win.document.documentElement.className = document.documentElement.className
    // Re-arm the light-dismiss guard so the reveal's focus change isn't a cancel.
    settledRef.current = false
    const settleTimer = window.setTimeout(() => { settledRef.current = true }, 250)
    return () => window.clearTimeout(settleTimer)
  }, [request, ensureWindow, close])

  // Position + reveal whenever the request or the panel height changes. Main
  // sets the bounds while hidden, then shows — so the first paint is correct.
  useEffect(() => {
    if (request == null || mountNode == null) return
    const height = panelOpen ? DESIGN_HEIGHT : PILL_HEIGHT
    const { left, top } = computeBounds(request, height)
    window.electronAPI?.annotationEditor?.show({ x: left, y: top, width: WIDTH, height })
  }, [request, panelOpen, mountNode, computeBounds])

  const onDesignChange = useCallback(
    (declarations: DesignDeclaration[], designText: DesignText | null) => {
      designRef.current =
        declarations.length > 0 || designText != null
          ? { declarations, text: designText }
          : null
      setHasDesign(designRef.current != null)
      requestRef.current?.onDesignChange(declarations, designText)
    },
    []
  )

  if (request == null || mountNode == null) return null

  const canSubmit = text.trim().length > 0 || hasDesign

  const submit = () => {
    if (!canSubmit) return
    requestRef.current?.onSubmit({ text: text.trim(), design: designRef.current })
    close()
  }
  const cancel = () => {
    requestRef.current?.onCancel()
    close()
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    } else if (e.key === "Escape") {
      e.preventDefault()
      cancel()
    }
  }

  // Round dark ✓ button (codex). Lives in the pill row when collapsed, in the
  // card footer when expanded.
  const submitBtn = (
    <button
      type="button"
      onClick={submit}
      disabled={!canSubmit}
      title="Submit"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition hover:opacity-90 disabled:opacity-40"
    >
      <Check className="h-4 w-4" />
    </button>
  )
  const sliderBtn =
    request.design != null ? (
      <button
        type="button"
        onClick={() => setPanelOpen((o) => !o)}
        title={panelOpen ? "Hide style controls" : "Adjust styles"}
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
          panelOpen
            ? "bg-secondary text-secondary-foreground"
            : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
        )}
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>
    ) : null
  const input = (
    <input
      autoFocus
      type="text"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={request.design != null ? "Describe these changes…" : "Add a comment…"}
      className="min-w-0 flex-1 bg-transparent px-1 text-[14px] text-foreground outline-none placeholder:text-muted-foreground/70"
    />
  )

  return createPortal(
    // Transparent window → only this rounded pill/card shows. Collapsed = pill;
    // expanded (design panel open) = card. The panel stays mounted (hidden when
    // collapsed) so edits + live preview survive toggling.
    <div className="h-screen w-screen p-1 text-popover-foreground">
      <div
        className={cn(
          "bg-popover ring-[1.5px] ring-border/50",
          panelOpen
            ? "flex h-full w-full flex-col gap-2 rounded-[20px] p-2.5"
            : "flex w-full flex-col rounded-full py-1.5 pl-2.5 pr-1.5"
        )}
      >
        <div className="flex items-center gap-1.5">
          {sliderBtn}
          {input}
          {!panelOpen ? submitBtn : null}
        </div>

        {request.design != null ? (
          <div
            className={
              panelOpen
                ? "flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/40 bg-muted/10"
                : "hidden"
            }
          >
            <div className="flex items-center gap-1.5 border-b border-border/40 px-2.5 py-1.5">
              <span className="flex-1 truncate text-xs font-medium text-foreground">
                {request.targetLabel}
              </span>
              <GripVertical className="h-3.5 w-3.5 text-muted-foreground/60" />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <AnnotationDesignPanel
                snapshot={request.design}
                initial={request.initialDesign ?? null}
                onChange={onDesignChange}
              />
            </div>
          </div>
        ) : null}

        {panelOpen ? (
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={cancel}
              className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
            >
              Cancel
            </button>
            {submitBtn}
          </div>
        ) : null}
      </div>
    </div>,
    mountNode
  )
}
