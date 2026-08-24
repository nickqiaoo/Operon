/**
 * Message protocol between the in-webview runtime (the guest-side preload,
 * `electron/webview-preload.ts`) and the host (`WebviewInstance`). Both sides
 * import these types so the channel stays in sync.
 *
 * Transport is Electron's native `<webview>` IPC: the guest uses
 * `ipcRenderer.sendToHost(CHANNEL, msg)` and the host receives via the
 * webview's `ipc-message` event; the host uses `webview.send(CHANNEL, msg)`
 * and the guest receives via `ipcRenderer.on(CHANNEL, …)`.
 */

export const BROWSER_RUNTIME_CHANNEL = "operon:browser-runtime"

/** Interaction mode of the in-webview runtime. */
export type BrowserInteractionMode = "browse" | "comment"

/**
 * A captured annotation target — the element the user clicked while in comment
 * mode. Coordinates in `rect`/`point` are in *document* space (scroll added)
 * unless the element is position:fixed/sticky, so the anchor survives scrolling
 * and can be re-resolved after reload via `selector`.
 */
/** Rect in document coords (viewport coords when isFixed). */
export interface AnchorRect {
  x: number
  y: number
  width: number
  height: number
}

/** A comment anchored to a specific DOM element (click selection). */
export interface ElementAnchor {
  kind: "element"
  /** Stable-ish CSS selector (≤4 ancestors, id / tag.class / :nth-of-type). */
  selector: string | null
  /** Lowercased tag name, e.g. "button". */
  tagName: string
  /** ARIA role attribute, if any. */
  role: string | null
  /** Accessible name: aria-label / title / trimmed text. */
  name: string | null
  /** Short trimmed text content of the element. */
  text: string | null
  /** Bounding box in document coords (viewport coords when isFixed). */
  rect: AnchorRect
  /** Click point — x as % of viewport width, y in document coords. */
  point: { xPercent: number; y: number }
  /** position:fixed/sticky? (changes the coordinate basis). */
  isFixed: boolean
  pageUrl: string
  pageTitle: string
}

/** A comment anchored to a dragged rectangular region (no specific element). */
export interface RegionAnchor {
  kind: "region"
  /** Region box in document coords. */
  rect: AnchorRect
  pageUrl: string
  pageTitle: string
}

export type Anchor = ElementAnchor | RegionAnchor

/** A submitted comment the host wants the guest to show as a pin on the page. */
export interface PageComment {
  id: string
  /** 1-based display number for the pin. */
  index: number
  text: string
  anchor: Anchor
}

// ---------------------------------------------------------------------------
// Design ("adjust") mode — tweak the selected element's CSS, preview it live,
// and send the requested change to the agent. Mirrors codex's
// `annotationEditorMode:'design'`; see spec §11.
// ---------------------------------------------------------------------------

/** A single tweakable CSS declaration. */
export interface DesignDeclaration {
  /** CSS property, kebab-case (e.g. "font-size", "padding-top"). */
  property: string
  /** Current value as a string (e.g. "16px", "rgb(26, 27, 35)", "#0a0a0a"). */
  value: string
  /** Original computed value — for diffing + reset. */
  previousValue: string
}

/** Editable direct-text content of the element. */
export interface DesignText {
  value: string
  previousValue: string
}

/**
 * Snapshot of an element's tweakable styles, captured by the guest at selection
 * and sent up so the host editor can offer the design ("adjust") panel.
 */
export interface DesignSnapshot {
  /** Declarations for the managed property set (color/font/border/box[/flex]). */
  declarations: DesignDeclaration[]
  /** Editable direct-text content, or null if the element has none. */
  text: DesignText | null
  /** display:flex|inline-flex — gates the layout (flex) controls. */
  isFlex: boolean
}

/** The design changes the user actually made (only changed declarations). */
export interface DesignSubmission {
  /** Only declarations whose value != previousValue. */
  declarations: DesignDeclaration[]
  /** Text change, or null if unchanged. */
  text: DesignText | null
}

/** Host → guest. */
export type BrowserRuntimeToGuest =
  | { type: "ping"; sentAt: number }
  | { type: "set-mode"; mode: BrowserInteractionMode }
  /** Host finished capturing the screenshot — guest may clear the highlight. */
  | { type: "capture-done" }
  /** Full list of comments to render as pins (re-sent on reload). */
  | { type: "sync-comments"; comments: PageComment[] }
  /**
   * Live design preview: apply these (changed-only) declarations + text to the
   * element whose editor is currently open. Sent as the user edits in the host
   * design panel; an empty set restores the element. Reverted on capture-done.
   */
  | { type: "design-preview"; declarations: DesignDeclaration[]; text: DesignText | null }
  /**
   * Before/after toggle (Phase 7): persistently apply EVERY submitted design
   * change to its element (resolved by selector) so the page shows the "after".
   * Re-sent whenever the annotation set changes while the toggle is on, and on
   * reload. Independent of the edit-time `design-preview`.
   */
  | { type: "design-show-all"; changes: DesignElementChange[] }
  /** Revert all `design-show-all` edits — show the original "before". */
  | { type: "design-hide-all" }

/** One element's requested CSS changes for the before/after overlay. */
export interface DesignElementChange {
  /** CSS selector to re-resolve the element on the live page. */
  selector: string
  declarations: DesignDeclaration[]
  text: DesignText | null
}

/** Guest → host. */
export type BrowserRuntimeToHost =
  | { type: "ready"; url: string }
  | { type: "pong"; receivedAt: number }
  | { type: "mode-changed"; mode: BrowserInteractionMode }
  /**
   * Editor opened on a target (comment in progress). `viewportRect` is the
   * target's rect in webview-viewport CSS px — the host converts it to screen
   * coords to position the child-window editor. `design` carries the element's
   * tweakable-styles snapshot (null for region anchors / non-HTML elements), so
   * the host can offer the design ("adjust") panel.
   */
  | {
      type: "open-editor"
      anchor: Anchor
      viewportRect: AnchorRect
      design: DesignSnapshot | null
      /** Set when re-opening an existing pin to EDIT it (host pre-fills + updates). */
      editId?: string
    }
  /**
   * User submitted a comment. The host captures the full viewport (with the
   * element still highlighted, design preview still applied), matching codex —
   * the agent gets the whole page for context, not a cropped element. `design`
   * carries the requested CSS changes (null if none).
   */
  | { type: "comment-submitted"; anchor: Anchor; text: string; design: DesignSubmission | null }
  /** Inline editor dismissed without submitting. */
  | { type: "comment-cancelled" }
