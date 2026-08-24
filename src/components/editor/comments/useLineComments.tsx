import { useCallback, useMemo, type ReactNode } from "react"
import type { SelectedLineRange } from "@pierre/diffs"
import {
  useLineCommentsStore,
  lineCommentsForFile,
  formatCommentLocation,
  type CommentSide,
} from "@/stores/line-comments-store"
import { LineCommentCard } from "./LineCommentCard"

/** Which surface the comments live on. Files are single-sided (`right`). */
export type LineCommentMode = "file" | "diff"

/**
 * Metadata carried on a pierre line annotation so `renderAnnotation` knows what
 * to draw. Kept as a single interface (not a union) because pierre's
 * `OptionalMetadata` is a distributive conditional — a union metadata type would
 * make the annotation require a concrete member instead of the whole type.
 */
export interface CommentMeta {
  location: string
  commentId: string
  text: string
  startEditing: boolean
}

/** A mode-agnostic anchored entry; each surface maps it to its pierre annotation
 *  shape (diff adds `side`, file uses `lineNumber` only). */
export interface CommentEntry {
  side: CommentSide
  line: number
  meta: CommentMeta
}

const sideFromRange = (range: SelectedLineRange, mode: LineCommentMode): CommentSide => {
  if (mode === "file") return "right"
  const s = range.side ?? range.endSide
  return s === "deletions" ? "left" : "right"
}

interface UseLineCommentsArgs {
  workspaceId: number | null
  path: string
  mode: LineCommentMode
}

interface UseLineCommentsResult {
  /** Anchored comments to turn into pierre `lineAnnotations`. */
  entries: CommentEntry[]
  /** Render the card for an annotation's metadata (pierre `renderAnnotation`). */
  renderCard: (meta: CommentMeta | undefined) => ReactNode
  /** Reserved for pierre's controlled line selection. */
  selectedLines: SelectedLineRange | null
  /** Create a fresh saved comment from a gutter-utility click. */
  onGutterUtilityClick: (range: SelectedLineRange) => void
  /** How many comments are anchored in this file (saved only). */
  count: number
}

/**
 * The shared line-comment engine for a single file, used by both the diff and
 * file-preview surfaces. Saved comments live in the global `line-comments-store`
 * (keyed by workspace, so the chat can send them). Returns the pieces each
 * surface feeds to pierre.
 */
export function useLineComments({
  workspaceId,
  path,
  mode,
}: UseLineCommentsArgs): UseLineCommentsResult {
  const items = useLineCommentsStore((s) => s.items)
  const add = useLineCommentsStore((s) => s.add)
  const updateText = useLineCommentsStore((s) => s.updateText)
  const remove = useLineCommentsStore((s) => s.remove)

  const saved = useMemo(
    () => lineCommentsForFile(items, workspaceId, path),
    [items, workspaceId, path]
  )

  const onGutterUtilityClick = useCallback(
    (range: SelectedLineRange) => {
      const side = sideFromRange(range, mode)
      const start = Math.min(range.start, range.end)
      const end = Math.max(range.start, range.end)
      const startLine = start !== end ? start : undefined
      if (saved.some((c) => c.side === side && c.line === end)) return
      add({
        id: crypto.randomUUID(),
        workspaceId,
        path,
        side,
        line: end,
        startLine,
        text: "",
        createdAt: Date.now(),
      })
    },
    [add, mode, path, saved, workspaceId]
  )

  const entries = useMemo<CommentEntry[]>(() => {
    return saved.map((c) => ({
      side: c.side,
      line: c.line,
      meta: {
        commentId: c.id,
        location: formatCommentLocation(c),
        text: c.text,
        startEditing: c.text.trim().length === 0,
      },
    }))
  }, [saved])

  const renderCard = useCallback(
    (meta: CommentMeta | undefined): ReactNode => {
      if (!meta) return null
      const commentId = meta.commentId
      return (
        <LineCommentCard
          location={meta.location}
          initialText={meta.text}
          startEditing={meta.startEditing}
          onSubmit={(text) => updateText(commentId, text)}
          onCancel={() => {
            if (!meta.text.trim()) remove(commentId)
          }}
          onDelete={() => remove(commentId)}
        />
      )
    },
    [updateText, remove]
  )

  return {
    entries,
    renderCard,
    selectedLines: null,
    onGutterUtilityClick,
    count: saved.length,
  }
}
