/**
 * The right panel's tab toolbars (file browser, review) are a row of capsules
 * floating over the content (Codex's layout) rather than a bordered bar. Every
 * control in them comes from these, so switching tabs doesn't make the row jump.
 *
 * Their menus and popovers pass `onCloseAutoFocus={(e) => e.preventDefault()}`:
 * Radix hands focus back to the trigger on close, Chrome counts that
 * programmatic focus as keyboard focus, and the capsule gets the system
 * `:focus-visible` ring (the macOS accent colour) after a plain mouse click.
 */

/** A bordered capsule that holds a control group (breadcrumb, change nav, …). */
export const TOOLBAR_PILL =
  "flex h-8 shrink-0 items-center overflow-hidden rounded-full border border-border/50 bg-background text-xs dark:border-border/35"

/**
 * A segment of a capsule. Square and flush: its hover fills the whole segment
 * and the capsule's rounded edge clips it, so a capsule reads as one split
 * button — a rounded, inset hover drew a second pill inside the first.
 */
export const TOOLBAR_PILL_BUTTON =
  "flex h-full shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"

/** A round icon-only button with no border (toggles). */
export const TOOLBAR_ICON_BUTTON =
  "flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"

/** Added to {@link TOOLBAR_ICON_BUTTON} while its toggle is on. */
export const TOOLBAR_ICON_BUTTON_ON = "bg-secondary text-foreground hover:bg-secondary-hover"
