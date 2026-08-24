// Sizes match Codex defaults so the UX feels consistent.
export const RIGHT_PANEL_DEFAULT_WIDTH = 720
export const RIGHT_PANEL_MIN_WIDTH = 280
// Backstop for very wide displays only. On ordinary window sizes the binding
// limit is `parentWidth - CENTER_CONTENT_MIN_WIDTH` (see RightPanel), so this
// number does nothing until the window is wide enough that letting the panel
// eat everything but the center reserve would leave a 1600px+ diff view. At
// that point the center gets the surplus instead, landing near the `max-w-4xl`
// reading width we use elsewhere.
export const RIGHT_PANEL_MAX_WIDTH = 1440
export const CENTER_CONTENT_MIN_WIDTH = 360
// Below this drag size the panel auto-closes. Same threshold as Codex.
export const RIGHT_PANEL_AUTO_CLOSE_BELOW = 320

// Narrower than the 256 Codex opens at: project/chat names truncate anyway, so
// the extra width bought nothing and the centre column reads better with it.
export const LEFT_SIDEBAR_DEFAULT_WIDTH = 224
export const LEFT_SIDEBAR_MIN_WIDTH = 208
export const LEFT_SIDEBAR_MAX_WIDTH = 480
// Below this drag size the sidebar auto-collapses (matches the right panel).
export const LEFT_SIDEBAR_AUTO_CLOSE_BELOW = 160

export const SIDE_FILE_TREE_DEFAULT_WIDTH = 260
export const SIDE_FILE_TREE_MIN_WIDTH = 180
export const SIDE_FILE_TREE_MAX_WIDTH = 420

export const clampSideFileTreeWidth = (value: number) =>
  Math.max(
    SIDE_FILE_TREE_MIN_WIDTH,
    Math.min(SIDE_FILE_TREE_MAX_WIDTH, value)
  )

export const BOTTOM_PANEL_DEFAULT_HEIGHT = 280
export const BOTTOM_PANEL_MIN_HEIGHT = 120
export const BOTTOM_PANEL_MAX_HEIGHT = 720
export const BOTTOM_PANEL_AUTO_CLOSE_BELOW = 160

export const PANEL_ANIMATION_DURATION = 0.22

export const STORAGE_KEY = "operon-app-shell"
