import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { TableOfContents } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface TocHeading {
  /** Anchor id — rehype-slug already put this on the rendered heading. */
  id: string
  text: string
  /** 0-based indent depth, normalised so the shallowest heading sits at 0. */
  depth: number
}

interface MarkdownTocProps {
  /** Element wrapping the rendered markdown. Headings are read out of it. */
  contentRef: RefObject<HTMLElement | null>
  /** Re-scan trigger — pass the markdown source so a new file rebuilds the list. */
  content: string
  className?: string
}

const HEADING_SELECTOR = "h1, h2, h3, h4"
/** Breathing room above a heading after jumping to it. */
const SCROLL_OFFSET = 12
/** A one- or two-heading document does not need a table of contents. */
const MIN_HEADINGS = 2
/** Leaving the icon closes the panel after this, so a diagonal exit forgives. */
const CLOSE_DELAY_MS = 120

/**
 * Table of contents for a markdown preview, rendered as a toolbar button that drops
 * down a clickable outline on hover (or on click/focus, which is what makes it
 * reachable by keyboard and on touch). Renders nothing when the document has too
 * few headings to navigate.
 *
 * It belongs in the toolbar, beside the preview/source toggle, rather than floating
 * over the prose. An earlier version pinned a rail of tick marks to the edge of the
 * reading column: it doubled as a minimap, but it read as a strip of reserved space
 * — and an outline that costs the reading column any width defeats its own purpose.
 * In the toolbar it costs none and overlaps nothing.
 *
 * Headings are read from the DOM rather than parsed out of the markdown source
 * so the ids always match whatever `rehype-slug` actually emitted — including
 * its de-duplication suffixes — and so text inside fenced code blocks is never
 * mistaken for a heading.
 */
export function MarkdownToc({ contentRef, content, className }: MarkdownTocProps) {
  const [headings, setHeadings] = useState<TocHeading[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<number | null>(null)

  const getViewport = useCallback((): HTMLElement | null => {
    const container = contentRef.current
    if (container == null) return null
    return (
      container.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ??
      container.parentElement
    )
  }, [contentRef])

  // Collect headings once the markdown has committed to the DOM. Streamdown can
  // take a frame or two to render, hence the short retry.
  useEffect(() => {
    let raf = 0
    let tries = 0
    const scan = () => {
      const container = contentRef.current
      const found =
        container == null
          ? []
          : Array.from(container.querySelectorAll<HTMLElement>(HEADING_SELECTOR))
              .filter((el) => el.id !== "")
              .map((el) => ({
                id: el.id,
                text: (el.textContent ?? "").trim(),
                level: Number(el.tagName.slice(1)),
              }))
              .filter((h) => h.text !== "")
      if (found.length === 0 && tries++ < 10) {
        raf = requestAnimationFrame(scan)
        return
      }
      // A README that starts at `##` should still be flush left in the outline.
      const minLevel = found.reduce((min, h) => Math.min(min, h.level), 6)
      setHeadings(
        found.map(({ id, text, level }) => ({
          id,
          text,
          depth: Math.min(level - minLevel, 3),
        }))
      )
      setActiveId(found[0]?.id ?? null)
    }
    raf = requestAnimationFrame(scan)
    return () => cancelAnimationFrame(raf)
  }, [content, contentRef])

  // Highlight the heading the reader is currently under.
  useEffect(() => {
    if (headings.length < MIN_HEADINGS) return
    const viewport = getViewport()
    const container = contentRef.current
    if (viewport == null || container == null) return

    let raf = 0
    const update = () => {
      raf = 0
      const top = viewport.getBoundingClientRect().top + SCROLL_OFFSET + 1
      let current = headings[0]?.id ?? null
      for (const heading of headings) {
        const el = findHeading(container, heading.id)
        if (el == null) continue
        if (el.getBoundingClientRect().top > top) break
        current = heading.id
      }
      setActiveId(current)
    }
    const onScroll = () => {
      if (raf !== 0) return
      raf = requestAnimationFrame(update)
    }

    update()
    viewport.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      viewport.removeEventListener("scroll", onScroll)
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [contentRef, getViewport, headings])

  useEffect(() => {
    return () => {
      if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current)
    }
  }, [])

  const cancelClose = () => {
    if (closeTimerRef.current == null) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }

  const scheduleClose = () => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setOpen(false)
    }, CLOSE_DELAY_MS)
  }

  const jumpTo = (id: string) => {
    const viewport = getViewport()
    const el = findHeading(contentRef.current, id)
    if (viewport == null || el == null) return
    const top =
      el.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top +
      viewport.scrollTop -
      SCROLL_OFFSET
    viewport.scrollTo({ top: Math.max(0, top), behavior: "smooth" })
    setActiveId(id)
  }

  if (headings.length < MIN_HEADINGS) return null

  return (
    <div
      className={cn("relative", className)}
      onMouseEnter={() => {
        cancelClose()
        setOpen(true)
      }}
      onMouseLeave={scheduleClose}
      onFocus={() => {
        cancelClose()
        setOpen(true)
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setOpen(false)
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Table of contents"
        title="Outline"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="h-7 w-7 px-0"
      >
        <TableOfContents className="h-3.5 w-3.5" />
      </Button>

      {/* Right-aligned: the button sits near the right edge of the toolbar, so a
          left-aligned panel would hang off the pane. */}
      <div
        className={cn(
          "absolute right-0 top-full z-20 mt-1 max-h-[min(70vh,28rem)] w-60 max-w-[min(15rem,60vw)] overflow-y-auto rounded-lg border border-border/60 bg-floating p-1.5 shadow-float transition-opacity duration-150",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        {headings.map((heading) => (
          <button
            key={heading.id}
            type="button"
            tabIndex={open ? 0 : -1}
            onClick={() => jumpTo(heading.id)}
            title={heading.text}
            className={cn(
              "block w-full truncate rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent-hover",
              INDENT[heading.depth],
              heading.id === activeId
                ? "font-medium text-foreground"
                : "text-muted-foreground"
            )}
          >
            {heading.text}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Scoped id lookup — chat markdown on screen carries the same slugs. */
function findHeading(container: HTMLElement | null, id: string): HTMLElement | null {
  if (container == null) return null
  return container.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
}

const INDENT = ["pl-2", "pl-4", "pl-6", "pl-8"] as const
