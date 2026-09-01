import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"

export interface SelectionContext {
  /** The selected text, trimmed. Never empty when an action fires. */
  text: string
  /**
   * The element matching `targetSelector` that contains the selection, or the
   * container itself when no selector was given. Lets an action read data
   * attributes off the thing that was selected — which message, which file.
   */
  target: HTMLElement
  /**
   * A detached clone of the selection, still valid after the live selection is
   * cleared. Lets an action recover more than the text — which lines were
   * covered, say — from the nodes the selection actually spanned.
   */
  range: Range
}

export interface SelectionAction {
  key: string
  label: ReactNode
  onSelect: (context: SelectionContext) => void
}

interface SelectionToolbarProps {
  /** Only selections inside this element are considered. */
  containerRef: RefObject<HTMLElement | null>
  /**
   * Narrows further: the selection must sit inside a descendant matching this,
   * and that descendant is what reaches the action as `context.target`. Without
   * it any selection in the container counts.
   */
  targetSelector?: string
  /** Rendered left to right. An empty list disables the toolbar entirely. */
  actions: SelectionAction[]
}

/**
 * Chrome exposes a selection per shadow root; the standard `Selection` API has
 * no equivalent, and `document.getSelection()` does not see inside one.
 */
type ShadowRootWithSelection = ShadowRoot & { getSelection?: () => Selection | null }

/**
 * Find a selection living inside an open shadow root under `container`.
 *
 * Pierre renders file contents into `fileContainer.attachShadow({ mode: 'open' })`,
 * so a selection in the source view is invisible to `window.getSelection()` and
 * `container.contains()` cannot reach its nodes either. Only light-DOM elements
 * are walked here, and Pierre keeps everything else inside the shadow, so this
 * is a short list.
 */
function readShadowSelection(
  container: HTMLElement
): { text: string; range: Range; host: HTMLElement } | null {
  for (const host of container.querySelectorAll<HTMLElement>("*")) {
    const root = host.shadowRoot as ShadowRootWithSelection | null
    if (root?.getSelection == null) continue
    const selection = root.getSelection()
    if (selection == null || selection.isCollapsed || selection.rangeCount === 0) continue
    const text = selection.toString().trim()
    if (text === "") continue
    return { text, range: selection.getRangeAt(0), host }
  }
  return null
}

/** Gap between the selection's top edge and the toolbar's bottom edge. */
const OFFSET_Y = 8
/** Keeps the toolbar from hanging off the viewport's left or right edge. */
const VIEWPORT_MARGIN = 8

interface ToolbarState {
  context: SelectionContext
  /** Viewport coordinates of the selection's bounding box. */
  rect: { top: number; left: number; width: number }
}

/**
 * A toolbar that floats above the current text selection.
 *
 * Modelled on the one in Codex, including the part that matters most: the
 * buttons are supplied by whoever mounts it, so the same component serves the
 * transcript ("Add to chat", "Ask in side chat") and a file preview ("Add to
 * chat", "Comment") without knowing anything about either.
 *
 * It settles on pointer-up rather than tracking `selectionchange`, so it does
 * not flicker along behind a drag, and it hides on scroll instead of chasing
 * the selection — the selection is still there when the user stops, and a
 * toolbar that follows a scrolling target reads as jitter.
 */
export function SelectionToolbar({ containerRef, targetSelector, actions }: SelectionToolbarProps) {
  const [state, setState] = useState<ToolbarState | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)

  const dismiss = useCallback(() => setState(null), [])

  /** Read the live selection, or null if it is not one we should act on. */
  const readSelection = useCallback((): ToolbarState | null => {
    const container = containerRef.current
    if (container == null) return null

    const selection = window.getSelection()
    const hasDocumentSelection =
      selection != null && !selection.isCollapsed && selection.rangeCount > 0
    const documentText = hasDocumentSelection ? selection.toString().trim() : ""

    if (!hasDocumentSelection || documentText === "") {
      // Nothing in the light DOM — the selection may be inside a shadow root,
      // which is where Pierre puts file contents.
      const shadow = readShadowSelection(container)
      if (shadow == null) return null
      const shadowRect = shadow.range.getBoundingClientRect()
      if (shadowRect.width === 0 && shadowRect.height === 0) return null
      // `targetSelector` matches light-DOM ancestors, so the host stands in for
      // the target here; a shadow surface is single-purpose anyway.
      return {
        context: { text: shadow.text, target: shadow.host, range: shadow.range.cloneRange() },
        rect: { top: shadowRect.top, left: shadowRect.left, width: shadowRect.width },
      }
    }

    const text = documentText
    const range = selection.getRangeAt(0)
    // `commonAncestorContainer` is a text node for a within-paragraph selection,
    // so climb to an element before matching.
    const anchor =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as HTMLElement)
        : range.commonAncestorContainer.parentElement
    if (anchor == null || !container.contains(anchor)) return null

    let target: HTMLElement = container
    if (targetSelector != null) {
      const matched = anchor.closest<HTMLElement>(targetSelector)
      // Outside every target — e.g. a selection in a user message when only
      // assistant messages are actionable.
      if (matched == null || !container.contains(matched)) return null
      target = matched
    }

    const rect = range.getBoundingClientRect()
    // A collapsed or zero-area rect means there is nothing to anchor to.
    if (rect.width === 0 && rect.height === 0) return null

    return {
      // Cloned now: the action runs after the live selection has been cleared.
      context: { text, target, range: range.cloneRange() },
      rect: { top: rect.top, left: rect.left, width: rect.width },
    }
  }, [containerRef, targetSelector])

  // Settle on pointer-up / key-up rather than on every selection change.
  useEffect(() => {
    if (actions.length === 0) return

    const settle = (event: Event) => {
      // A click on the toolbar is not a new selection — it is the user taking
      // the action, and reading the selection here would clear it first.
      const node = event.target as Node | null
      if (node != null && toolbarRef.current?.contains(node) === true) return
      // Let the browser finish updating the selection for this gesture.
      requestAnimationFrame(() => setState(readSelection()))
    }

    document.addEventListener("mouseup", settle)
    document.addEventListener("keyup", settle)
    return () => {
      document.removeEventListener("mouseup", settle)
      document.removeEventListener("keyup", settle)
    }
  }, [actions.length, readSelection])

  // Anything that moves the selection out from under the toolbar closes it.
  useEffect(() => {
    if (state == null) return
    // Capture phase: catches scrolling in any ancestor, not just the window.
    window.addEventListener("scroll", dismiss, true)
    window.addEventListener("resize", dismiss)
    return () => {
      window.removeEventListener("scroll", dismiss, true)
      window.removeEventListener("resize", dismiss)
    }
  }, [state, dismiss])

  if (state == null || actions.length === 0) return null

  // Centre on the selection, then pull back inside the viewport.
  const estimatedWidth = toolbarRef.current?.offsetWidth ?? 0
  const centred = state.rect.left + state.rect.width / 2 - estimatedWidth / 2
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(centred, window.innerWidth - estimatedWidth - VIEWPORT_MARGIN)
  )

  return createPortal(
    <div
      ref={toolbarRef}
      // `fixed` because the coordinates are the selection's viewport rect, and
      // the portal target is outside every scroll container anyway.
      className="fixed z-50 flex items-center overflow-hidden rounded-lg border border-border/60 bg-floating shadow-float"
      style={{
        top: state.rect.top - OFFSET_Y,
        left,
        transform: "translateY(-100%)",
      }}
      // Keep the selection alive: a pointer-down inside the toolbar would
      // otherwise collapse it before the click lands.
      onMouseDown={(event) => event.preventDefault()}
    >
      {actions.map((action, index) => (
        <button
          key={action.key}
          type="button"
          className={cn(
            "px-3 py-1.5 text-xs whitespace-nowrap text-foreground transition-colors hover:bg-accent-hover",
            index > 0 && "border-l border-border/40"
          )}
          onClick={() => {
            const { context } = state
            setState(null)
            window.getSelection()?.removeAllRanges()
            action.onSelect(context)
          }}
        >
          {action.label}
        </button>
      ))}
    </div>,
    document.body
  )
}
