import { create } from "zustand"
import type {
  DesignDeclaration,
  DesignSnapshot,
  DesignSubmission,
  DesignText,
} from "@/types/browser-runtime"

/**
 * Drives the child-window annotation editor (Phase 6). `WebviewInstance`
 * computes the target's screen position and opens a request here;
 * `AnnotationEditorHost` (mounted once at the app root) renders the editor in a
 * frameless child window via `window.open` + a React portal, and calls back on
 * submit/cancel. When `design` is present it also renders the design ("adjust")
 * panel and streams live edits back through `onDesignChange`.
 */
export interface AnnotationEditorRequest {
  /** Target's top-left in SCREEN CSS px. */
  screen: { x: number; y: number }
  /** Target height (the editor is placed just below it). */
  targetHeight: number
  /** Element tag (card title), or "region". */
  targetLabel: string
  /** Tweakable-styles snapshot, or null (region anchors / capture failed). */
  design: DesignSnapshot | null
  /** Pre-fill when editing an existing pin: its comment text + prior design. */
  initialText?: string
  initialDesign?: DesignSubmission | null
  onSubmit: (payload: { text: string; design: DesignSubmission | null }) => void
  /** Live preview: fired (debounced by the panel) as the user edits styles. */
  onDesignChange: (declarations: DesignDeclaration[], text: DesignText | null) => void
  onCancel: () => void
}

interface AnnotationEditorState {
  request: AnnotationEditorRequest | null
  open: (request: AnnotationEditorRequest) => void
  close: () => void
}

export const useAnnotationEditorStore = create<AnnotationEditorState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}))
