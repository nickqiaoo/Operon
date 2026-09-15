import { useCallback, useEffect, useRef, useState } from "react"

export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

/** Highlight names; styled by `::highlight(...)` in globals.css and the Pierre shadow CSS. */
export const FIND_MATCH_HIGHLIGHT = "file-find-match"
export const FIND_CURRENT_HIGHLIGHT = "file-find-current"

/**
 * CSS for `::highlight()` inside a shadow root. Document styles don't reach
 * into shadow trees, so the Pierre source view has to carry its own copy.
 */
export const FIND_HIGHLIGHT_CSS = `
::highlight(${FIND_MATCH_HIGHLIGHT}) { background-color: var(--find-match); }
::highlight(${FIND_CURRENT_HIGHLIGHT}) { background-color: var(--find-match-current); }
`

/** Past this many matches the count reads "10000+" and the rest are ignored. */
const MAX_MATCHES = 10000

const BLOCK_SELECTOR =
  "[data-line],p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre,dt,dd,summary,figcaption"

export interface TextFindTarget {
  /** Element or shadow root to search and watch for re-renders. */
  root: Node
  /** Return false for text that isn't content (line numbers, diagram labels…). */
  accept: (text: Text) => boolean
}

interface UseTextFindArgs {
  /** Resolve the current search target; `null` while nothing is rendered. */
  getTarget: () => TextFindTarget | null
  /** Only one pane may own the (document-global) highlight registry at a time. */
  enabled: boolean
  query: string
  options: FindOptions
  /** Anything that swaps the rendered content (file text, preview/source mode). */
  contentKey: unknown
}

export interface TextFindState {
  count: number
  /** 0-based index of the current match, or -1 when there is none. */
  index: number
  truncated: boolean
  /** Set when the query is an invalid regular expression. */
  error: string | null
  next: () => void
  previous: () => void
}

export function buildFindPattern(query: string, options: FindOptions): RegExp {
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const wrapped = options.wholeWord ? `\\b(?:${source})\\b` : source
  return new RegExp(wrapped, options.caseSensitive ? "g" : "gi")
}

/**
 * Matches inside one run of text. Zero-width matches (`^`, `\b`, `a*`) are
 * skipped instead of looping forever on the same offset.
 */
export function findMatchOffsets(text: string, pattern: RegExp, limit: number): [number, number][] {
  const out: [number, number][] = []
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while (out.length < limit && (match = pattern.exec(text)) != null) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1
      continue
    }
    out.push([match.index, match.index + match[0].length])
  }
  return out
}

function blockOf(text: Text, root: Node): Node {
  return text.parentElement?.closest(BLOCK_SELECTOR) ?? root
}

/**
 * Text nodes grouped into runs that belong to the same block, so a match can
 * span syntax-highlight spans (`foo` + `Bar`) but never jumps from one line or
 * paragraph into the next.
 */
function collectRuns(target: TextFindTarget): Text[][] {
  const walker = document.createTreeWalker(target.root, NodeFilter.SHOW_TEXT)
  const runs: Text[][] = []
  let current: Text[] = []
  let currentBlock: Node | null = null
  for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
    const text = node as Text
    if (text.data.length === 0 || !target.accept(text)) continue
    const block = blockOf(text, target.root)
    if (block !== currentBlock && current.length > 0) {
      runs.push(current)
      current = []
    }
    currentBlock = block
    current.push(text)
  }
  if (current.length > 0) runs.push(current)
  return runs
}

function rangesFor(target: TextFindTarget, pattern: RegExp): { ranges: Range[]; truncated: boolean } {
  const ranges: Range[] = []
  for (const run of collectRuns(target)) {
    const starts: number[] = []
    let joined = ""
    for (const text of run) {
      starts.push(joined.length)
      joined += text.data
    }
    // Map an offset in the joined string back to (node, offset). `end` offsets
    // resolve to the end of the earlier node rather than the start of the next.
    const locate = (offset: number, isEnd: boolean): [Text, number] => {
      for (let i = run.length - 1; i >= 0; i--) {
        if (isEnd ? starts[i] < offset : starts[i] <= offset) return [run[i], offset - starts[i]]
      }
      return [run[0], 0]
    }
    for (const [start, end] of findMatchOffsets(joined, pattern, MAX_MATCHES - ranges.length)) {
      const range = new Range()
      range.setStart(...locate(start, false))
      range.setEnd(...locate(end, true))
      ranges.push(range)
    }
    if (ranges.length >= MAX_MATCHES) return { ranges, truncated: true }
  }
  return { ranges, truncated: false }
}

function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
}

/**
 * The highlight registry is document-global but every open file keeps its own
 * pane mounted, so track which one painted last: a pane going inactive must not
 * wipe the matches the newly active pane just drew.
 */
let highlightOwner: object | null = null

function clearHighlights(owner: object) {
  if (!highlightsSupported() || highlightOwner !== owner) return
  highlightOwner = null
  CSS.highlights.delete(FIND_MATCH_HIGHLIGHT)
  CSS.highlights.delete(FIND_CURRENT_HIGHLIGHT)
}

/** Nearest vertically scrollable ancestor, crossing shadow boundaries. */
function scrollParentOf(node: Node): HTMLElement | null {
  let el: Element | null = node instanceof Element ? node : node.parentElement
  while (el != null) {
    if (el instanceof HTMLElement) {
      const { overflowY } = getComputedStyle(el)
      if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) return el
    }
    const parent: Element | null = el.parentElement
    el = parent ?? ((el.getRootNode() as ShadowRoot).host ?? null)
  }
  return null
}

/**
 * Scroll the match to the middle when it's out of view. Deliberately not
 * `scrollIntoView`, which also scrolls `overflow: hidden` ancestors and can
 * shove the whole panel layout sideways.
 */
function revealRange(range: Range) {
  const container = scrollParentOf(range.startContainer)
  if (container == null) return
  const rect = range.getBoundingClientRect()
  const bounds = container.getBoundingClientRect()
  const margin = 24
  if (rect.top >= bounds.top + margin && rect.bottom <= bounds.bottom - margin) return
  container.scrollTop += rect.top - bounds.top - bounds.height / 2 + rect.height / 2
}

/**
 * Find-in-page scoped to one rendered file. Matches are painted with the CSS
 * Custom Highlight API, so the DOM (which Pierre and Streamdown own) is never
 * touched — and re-renders of that DOM just trigger a re-scan.
 */
export function useTextFind({ getTarget, enabled, query, options, contentKey }: UseTextFindArgs): TextFindState {
  const ownerRef = useRef({})
  const rangesRef = useRef<Range[]>([])
  const indexRef = useRef(-1)
  const getTargetRef = useRef(getTarget)
  getTargetRef.current = getTarget
  const [state, setState] = useState({ count: 0, index: -1, truncated: false, error: null as string | null })

  const paintCurrent = useCallback((reveal: boolean) => {
    if (!highlightsSupported()) return
    const range = rangesRef.current[indexRef.current]
    if (range == null) {
      CSS.highlights.delete(FIND_CURRENT_HIGHLIGHT)
      return
    }
    highlightOwner = ownerRef.current
    CSS.highlights.set(FIND_CURRENT_HIGHLIGHT, new Highlight(range))
    if (reveal) revealRange(range)
  }, [])

  const scan = useCallback(
    (resetIndex: boolean) => {
      const target = enabled && query.length > 0 ? getTargetRef.current() : null
      if (target == null) {
        rangesRef.current = []
        indexRef.current = -1
        clearHighlights(ownerRef.current)
        setState({ count: 0, index: -1, truncated: false, error: null })
        return
      }
      let pattern: RegExp
      try {
        pattern = buildFindPattern(query, options)
      } catch (err) {
        rangesRef.current = []
        indexRef.current = -1
        clearHighlights(ownerRef.current)
        setState({ count: 0, index: -1, truncated: false, error: err instanceof Error ? err.message : "Invalid pattern" })
        return
      }
      const { ranges, truncated } = rangesFor(target, pattern)
      rangesRef.current = ranges
      indexRef.current = ranges.length === 0 ? -1 : resetIndex ? 0 : Math.min(Math.max(indexRef.current, 0), ranges.length - 1)
      if (ranges.length === 0) clearHighlights(ownerRef.current)
      else if (highlightsSupported()) {
        highlightOwner = ownerRef.current
        CSS.highlights.set(FIND_MATCH_HIGHLIGHT, new Highlight(...ranges))
      }
      paintCurrent(resetIndex)
      setState({ count: ranges.length, index: indexRef.current, truncated, error: null })
    },
    // `options` fields rather than the object, so a fresh-but-equal object doesn't rescan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, query, options.caseSensitive, options.wholeWord, options.regex, paintCurrent]
  )

  // New query, options or content: rescan and jump to the first match. Merely
  // becoming the active pane again repaints without moving the scroll position.
  const lastSearchRef = useRef<unknown[] | null>(null)
  useEffect(() => {
    const search = [query, options.caseSensitive, options.wholeWord, options.regex, contentKey]
    const previous = lastSearchRef.current
    const changed = previous == null || search.some((value, i) => value !== previous[i])
    lastSearchRef.current = search
    // Pierre and Streamdown render a frame after the content arrives.
    const raf = requestAnimationFrame(() => scan(changed))
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan, contentKey])

  // Re-renders of the same content (syntax highlighting landing, a diagram
  // finishing) replace text nodes and orphan the ranges; rescan in place.
  useEffect(() => {
    if (!enabled || query.length === 0) return
    const target = getTargetRef.current()
    if (target == null) return
    let timer = 0
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => scan(false), 120)
    })
    observer.observe(target.root, { childList: true, subtree: true, characterData: true })
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [enabled, query, scan, contentKey])

  useEffect(() => {
    const owner = ownerRef.current
    return () => clearHighlights(owner)
  }, [])

  const step = useCallback(
    (delta: number) => {
      const count = rangesRef.current.length
      if (count === 0) return
      indexRef.current = (indexRef.current + delta + count) % count
      paintCurrent(true)
      setState((s) => ({ ...s, index: indexRef.current }))
    },
    [paintCurrent]
  )
  const next = useCallback(() => step(1), [step])
  const previous = useCallback(() => step(-1), [step])

  return { ...state, next, previous }
}
