import { create } from "zustand"
import type { Anchor, DesignSubmission } from "@/types/browser-runtime"

/**
 * The single source of truth for browser annotations (codex-style "comment on a
 * page element"). One persistent list, each item tagged with BOTH the browser
 * tab that owns it (`instanceId`, for the on-page pins) and the workspace
 * (`workspaceId`, for the chat-side list). Each side filters its own view, so a
 * delete from either the page or the chat updates both: they stay linked.
 *
 * Replaces the old transient `pending-annotations-store` (one-shot ingest into a
 * composer attachment). Annotations now persist as editable state until cleared
 * or sent.
 */
export interface Annotation {
  id: string
  /** Browser tab (WebviewInstance) the annotation was made on — owns the pin. */
  instanceId: string
  /** Workspace active at creation — the chat list filters on this. */
  workspaceId: number | null
  /** Annotated element / region. */
  anchor: Anchor
  /** The user's comment text (may be empty for a design-only annotation). */
  comment: string
  /** Requested CSS tweaks (design mode), or null. */
  design: DesignSubmission | null
  /** Pre-formatted markdown (anchor context + design block) for the agent. */
  context: string
  /** Full-viewport screenshot at submit (preview applied), or null. */
  screenshotDataUrl: string | null
  createdAt: number
}

interface AnnotationsState {
  items: Annotation[]
  add: (annotation: Annotation) => void
  /** Replace an existing annotation in place (edit), or append if new. */
  upsert: (annotation: Annotation) => void
  remove: (id: string) => void
  /** Clear every annotation for a browser tab (the toolbar trash). */
  clearInstance: (instanceId: string) => void
}

export const useAnnotationsStore = create<AnnotationsState>((set) => ({
  items: [],
  add: (annotation) => set((s) => ({ items: [...s.items, annotation] })),
  upsert: (annotation) =>
    set((s) => {
      const i = s.items.findIndex((x) => x.id === annotation.id)
      if (i < 0) return { items: [...s.items, annotation] }
      const items = s.items.slice()
      items[i] = annotation
      return { items }
    }),
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clearInstance: (instanceId) =>
    set((s) => ({ items: s.items.filter((i) => i.instanceId !== instanceId) })),
}))

/** Annotations for one browser tab, oldest first (pin order). */
export const annotationsForInstance = (
  items: Annotation[],
  instanceId: string
): Annotation[] => items.filter((i) => i.instanceId === instanceId)

/** Annotations for one workspace's chat list, oldest first. */
export const annotationsForWorkspace = (
  items: Annotation[],
  workspaceId: number | null
): Annotation[] => items.filter((i) => i.workspaceId === workspaceId)
