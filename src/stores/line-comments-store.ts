import { create } from "zustand"
import type { FileUIPart } from "ai"

/**
 * Codex-style inline "comment on a diff/file line". The user clicks a line in a
 * diff or file preview, writes a note, and it hangs off the line as an editable
 * card. Queued comments fold into the next chat message (as text context) and
 * are cleared on send — the same shape as the browser-annotation flow
 * (`annotations-store` / `AnnotationTray`), but anchored to a source line
 * instead of a DOM element.
 *
 * Comments are keyed by `workspaceId` (like browser annotations): every line
 * comment made in a workspace is picked up by that workspace's focused chat
 * when it sends. Both the diff surface and the file preview feed the SAME
 * store, so the two surfaces behave identically.
 */

/** Diff side a comment is anchored to. File previews are always `right`. */
export type CommentSide = "left" | "right"

export interface LineComment {
  id: string
  /** Workspace active when the comment was made — the chat list filters on this. */
  workspaceId: number | null
  /** File path as shown in the preview/diff header. */
  path: string
  /** `left` = deletions/old side, `right` = additions/new side (or a plain file). */
  side: CommentSide
  /** 1-based end line the comment is anchored to. */
  line: number
  /** 1-based start line for a range comment (omitted for single-line). */
  startLine?: number
  /** The user's note. */
  text: string
  /** Surrounding diff hunk, sent to the agent as context (diff surface only). */
  diffHunk?: string
  createdAt: number
}

interface LineCommentsState {
  items: LineComment[]
  add: (comment: LineComment) => void
  /** Replace an existing comment in place (edit); append if new. */
  upsert: (comment: LineComment) => void
  updateText: (id: string, text: string) => void
  remove: (id: string) => void
  /** Drop every comment for a workspace (after they've been sent). */
  clearWorkspace: (workspaceId: number | null) => void
}

export const useLineCommentsStore = create<LineCommentsState>((set) => ({
  items: [],
  add: (comment) => set((s) => ({ items: [...s.items, comment] })),
  upsert: (comment) =>
    set((s) => {
      const i = s.items.findIndex((x) => x.id === comment.id)
      if (i < 0) return { items: [...s.items, comment] }
      const items = s.items.slice()
      items[i] = comment
      return { items }
    }),
  updateText: (id, text) =>
    set((s) => ({
      items: s.items.map((c) => (c.id === id ? { ...c, text } : c)),
    })),
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clearWorkspace: (workspaceId) =>
    set((s) => ({ items: s.items.filter((i) => i.workspaceId !== workspaceId) })),
}))

/** Comments for one workspace's chat list, oldest first. */
export const lineCommentsForWorkspace = (
  items: LineComment[],
  workspaceId: number | null
): LineComment[] => items.filter((i) => i.workspaceId === workspaceId && i.text.trim().length > 0)

/** Comments anchored in one file within a workspace, oldest first. */
export const lineCommentsForFile = (
  items: LineComment[],
  workspaceId: number | null,
  path: string
): LineComment[] =>
  items.filter((i) => i.workspaceId === workspaceId && i.path === path)

/** `L12` / `R12` / `R12-R18` — the human line label, matching Codex's notation. */
export const formatCommentLocation = (comment: LineComment): string => {
  const prefix = comment.side === "left" ? "L" : "R"
  if (comment.startLine != null && comment.startLine !== comment.line) {
    return `${prefix}${comment.startLine}-${prefix}${comment.line}`
  }
  return `${prefix}${comment.line}`
}

/** Composer file mirroring `AnnotationFile`: an `asText` snippet merged into the
 *  outgoing message by `useChatActions`. */
export type LineCommentFile = FileUIPart & {
  id: string
  content?: string
  asText?: boolean
}

/**
 * Serialize one line comment into a markdown context snippet for the agent:
 * the file + line location, the surrounding diff hunk (if any), then the note.
 */
export const lineCommentToFile = (comment: LineComment): LineCommentFile => {
  const location = formatCommentLocation(comment)
  const parts = [`Comment on \`${comment.path}\` (line ${location}):`]
  const hunk = comment.diffHunk?.trim()
  if (hunk) parts.push("```diff\n" + hunk + "\n```")
  parts.push(comment.text.trim())
  const markdown = parts.filter(Boolean).join("\n\n")
  return {
    id: `${comment.id}-cmt`,
    type: "file",
    filename: "line-comment.md",
    mediaType: "text/markdown",
    url: `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`,
    content: markdown,
    asText: true,
  }
}
