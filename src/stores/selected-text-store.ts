import { create } from "zustand"
import type { FileUIPart } from "ai"
import { sameNode } from "@/lib/chat-ref"

/**
 * Text a user picked out of a file preview and sent to the chat.
 *
 * The same shape as `line-comments-store` and `annotations-store`, and for the
 * same reason: the selection is made on one surface (a file preview) while the
 * conversation that will carry it lives on another, so it is keyed by
 * `workspaceId` and picked up by that workspace's focused chat when it sends.
 *
 * Deliberately NOT used for a selection made inside the transcript. There the
 * conversation is right there, so the quote goes straight into the composer
 * where the user can see it and write underneath it.
 */

export interface SelectedTextSnippet {
  id: string
  /** Workspace active when the text was picked — the chat filters on this. */
  workspaceId: number | null
  /**
   * Machine of that workspace; undefined for this one. Workspace ids are only
   * unique per machine, so remote workspace 3 must not pick up local 3's items.
   */
  nodeId?: string
  /**
   * Chat this snippet is bound to. Set when the selection was made with a
   * specific conversation in mind (in a transcript, or on the way into a side
   * chat). Left undefined by a file preview, which has no conversation in view —
   * those show up in whichever chat the workspace has focused.
   */
  chatId?: number
  /** File path for a preview selection; omitted for one made in a transcript. */
  path?: string
  /** `12` or `12-18`, when the surface had line numbers. Absent for rendered views. */
  location?: string
  text: string
  createdAt: number
}

interface SelectedTextState {
  items: SelectedTextSnippet[]
  add: (snippet: SelectedTextSnippet) => void
  remove: (id: string) => void
  /** Drop every snippet for a workspace (after they've been sent). */
  clearWorkspace: (workspaceId: number | null, nodeId?: string | null) => void
}

export const useSelectedTextStore = create<SelectedTextState>((set) => ({
  items: [],
  add: (snippet) => set((s) => ({ items: [...s.items, snippet] })),
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  // Every send calls this. With nothing to drop, keep the same array: a fresh
  // one re-renders every subscriber, and the file preview's `<File>` then
  // rebuilds the whole highlighted file inside the Enter keypress.
  clearWorkspace: (workspaceId, nodeId) =>
    set((s) => {
      const inWorkspace = (i: SelectedTextSnippet) => i.workspaceId === workspaceId && sameNode(i.nodeId, nodeId)
      return s.items.some(inWorkspace) ? { items: s.items.filter((i) => !inWorkspace(i)) } : s
    }),
}))

/**
 * Snippets a given chat should carry: everything loose in the workspace, plus
 * anything bound to this chat specifically. A snippet bound to another chat
 * (a side chat, say) stays out of this one.
 */
export const selectedTextForChat = (
  items: SelectedTextSnippet[],
  workspaceId: number | null,
  chatId: number | undefined,
  nodeId?: string | null
): SelectedTextSnippet[] =>
  items.filter(
    (i) =>
      i.workspaceId === workspaceId &&
      sameNode(i.nodeId, nodeId) &&
      (i.chatId == null || i.chatId === chatId)
  )

/** Composer file mirroring `LineCommentFile`: an `asText` snippet merged into
 *  the outgoing message by `ChatPanel.handleSubmit`. */
export type SelectedTextFile = FileUIPart & {
  id: string
  content?: string
  asText?: boolean
}

/**
 * Fold a snippet into the next message as a text attachment, the same way line
 * comments and browser annotations travel.
 */
export const selectedTextToFile = (snippet: SelectedTextSnippet): SelectedTextFile => {
  const quoted = snippet.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
  const where =
    snippet.path == null
      ? null
      : snippet.location != null
        ? `${snippet.path} (line ${snippet.location})`
        : snippet.path
  const heading = where == null ? "Selected text:" : `Selected from \`${where}\`:`
  const markdown = `${heading}\n\n${quoted}`
  return {
    id: `${snippet.id}-sel`,
    type: "file",
    filename: "selected-text.md",
    mediaType: "text/markdown",
    url: `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`,
    content: markdown,
    asText: true,
  }
}
