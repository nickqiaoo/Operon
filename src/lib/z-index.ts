/**
 * The app's body-level stacking layers, lowest first. Everything that portals to
 * `<body>` competes on these numbers alone, so each layer gets its own band:
 *
 * - `HOST_SURFACE` (40): the Electron `<webview>` and xterm containers. They sit
 *   over in-tree placeholders, and must stay under every host overlay so a menu
 *   or dialog covers them through plain stacking (no "hide on overlay" hack).
 * - `FULL_PAGE` (41…49): Settings / Plugins / Canvas / Schedule, each `+ index`
 *   of the page stack. Above the host surfaces they cover, and **below** the
 *   overlay layer: a dialog, select or menu opened from any page — including one
 *   stacked on top of another — must paint over it.
 * - 50: Radix overlays (dialog, popover, select, dropdown, tooltip, hover card),
 *   set as `z-50` in `src/components/ui/*`. Several of them open from inside a
 *   dialog; equal z-index plus later portal order puts the newer one on top, so
 *   call sites never need their own `z-[80]`.
 * - 60+: web-build chrome that floats above everything (install / update
 *   prompts, the sign-in footer, the request progress bar).
 */
export const Z_HOST_SURFACE = 40
/** Base of the page stack; with at most a handful of page kinds it never reaches 50. */
export const Z_FULL_PAGE = 41
