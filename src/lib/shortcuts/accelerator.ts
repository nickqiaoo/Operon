/**
 * Keyboard accelerators, in Electron's string format ("CmdOrCtrl+Shift+G").
 *
 * Same shape codex uses for its command table, and it's worth keeping: one
 * string is readable in a config, survives JSON round-trips, and prints in the
 * settings UI without a second representation to keep in sync.
 *
 * Matching goes through `event.code`, never `event.key`. macOS rewrites `key`
 * while Option is held — ⌥S arrives as "ß" — so a key-based match would drop
 * every Option binding. `code` is the physical key and is stable.
 */

/**
 * Read per call, not captured at module load: the settings page and the tests
 * both need the platform branch to be observable, and a frozen constant makes
 * the non-macOS path unreachable from a Mac.
 */
export function isMacPlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.platform.toLowerCase().includes("mac")
  )
}

export interface ParsedAccelerator {
  /** The platform's primary modifier: ⌘ on macOS, Ctrl elsewhere. */
  mod: boolean
  /** A literal Control, which stays Control on macOS too. */
  ctrl: boolean
  shift: boolean
  alt: boolean
  /** `KeyboardEvent.code` of the non-modifier key. */
  code: string
}

/**
 * Accelerator key name → `KeyboardEvent.code`. Only the keys we let people bind;
 * anything outside this table fails to parse rather than binding something the
 * settings UI can't print back.
 */
const CODE_BY_KEY: Record<string, string> = {
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  space: "Space",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  esc: "Escape",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
}

const KEY_BY_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(CODE_BY_KEY).map(([key, code]) => [code, key])
)

/** How each code prints in the UI. Letters/digits print themselves. */
const LABEL_BY_CODE: Record<string, string> = {
  Space: "Space",
  Enter: "↩",
  Tab: "⇥",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
}

const codeForKey = (raw: string): string | null => {
  const key = raw.trim()
  if (key.length === 0) return null
  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  return CODE_BY_KEY[key.toLowerCase()] ?? CODE_BY_KEY[key] ?? null
}

const keyForCode = (code: string): string | null => {
  if (code.startsWith("Key")) return code.slice(3)
  if (code.startsWith("Digit")) return code.slice(5)
  return KEY_BY_CODE[code] ?? null
}

/** Returns null for anything unparseable, so a bad stored value is inert. */
export function parseAccelerator(accelerator: string): ParsedAccelerator | null {
  const parts = accelerator.split("+").map((p) => p.trim()).filter((p) => p.length > 0)
  if (parts.length === 0) return null

  const parsed: ParsedAccelerator = {
    mod: false,
    ctrl: false,
    shift: false,
    alt: false,
    code: "",
  }
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "cmdorctrl":
      case "commandorcontrol":
        parsed.mod = true
        break
      case "cmd":
      case "command":
      case "super":
      case "meta":
        // A literal ⌘ only exists on macOS; elsewhere fold it into the primary
        // modifier so a binding written for a Mac still does something sane.
        if (isMacPlatform()) parsed.mod = true
        else parsed.ctrl = true
        break
      case "ctrl":
      case "control":
        parsed.ctrl = true
        break
      case "shift":
        parsed.shift = true
        break
      case "alt":
      case "option":
        parsed.alt = true
        break
      default: {
        // Two non-modifier keys is malformed, not a chord — we don't support chords.
        if (parsed.code.length > 0) return null
        const code = codeForKey(part)
        if (code == null) return null
        parsed.code = code
      }
    }
  }
  return parsed.code.length > 0 ? parsed : null
}

export function matchesAccelerator(
  event: KeyboardEvent,
  accelerator: string
): boolean {
  const parsed = parseAccelerator(accelerator)
  if (parsed == null) return false
  if (event.code !== parsed.code) return false
  // Off macOS there is no ⌘, so the primary modifier IS Control and the two
  // flags collapse into one.
  const mac = isMacPlatform()
  const wantCtrl = mac ? parsed.ctrl : parsed.ctrl || parsed.mod
  const wantMeta = mac && parsed.mod
  return (
    event.ctrlKey === wantCtrl &&
    event.metaKey === wantMeta &&
    event.shiftKey === parsed.shift &&
    event.altKey === parsed.alt
  )
}

/** "⌃⇧G" on macOS, "Ctrl+Shift+G" elsewhere. Empty string if unparseable. */
export function formatAccelerator(accelerator: string): string {
  const parsed = parseAccelerator(accelerator)
  if (parsed == null) return ""
  const label = LABEL_BY_CODE[parsed.code] ?? keyForCode(parsed.code) ?? parsed.code
  if (isMacPlatform()) {
    // macOS prints modifiers in this order however you hold them.
    return (
      (parsed.ctrl ? "⌃" : "") +
      (parsed.alt ? "⌥" : "") +
      (parsed.shift ? "⇧" : "") +
      (parsed.mod ? "⌘" : "") +
      label
    )
  }
  const parts: string[] = []
  if (parsed.mod || parsed.ctrl) parts.push("Ctrl")
  if (parsed.alt) parts.push("Alt")
  if (parsed.shift) parts.push("Shift")
  parts.push(label)
  return parts.join("+")
}

const MODIFIER_CODES = new Set([
  "ShiftLeft", "ShiftRight",
  "ControlLeft", "ControlRight",
  "AltLeft", "AltRight",
  "MetaLeft", "MetaRight",
  "CapsLock",
])

/**
 * Turns a keypress into an accelerator string, for the "press a shortcut"
 * recorder in settings. Returns null while only modifiers are held, and for
 * anything without ⌘/Ctrl/Alt — a bare (or merely shifted) letter would swallow
 * typing everywhere in the app.
 */
export function acceleratorFromEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(event.code)) return null
  // Shift alone is not a modifier for this purpose: "Shift+G" would swallow
  // every capital G the user types. Require ⌘/Ctrl/Alt.
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return null
  const key = keyForCode(event.code)
  if (key == null) return null

  const parts: string[] = []
  // Meta on macOS and Control elsewhere are the same intent, so both record as
  // CmdOrCtrl and the binding stays portable.
  const mac = isMacPlatform()
  if (mac ? event.metaKey : event.ctrlKey) parts.push("CmdOrCtrl")
  if (mac && event.ctrlKey) parts.push("Control")
  if (event.altKey) parts.push("Alt")
  if (event.shiftKey) parts.push("Shift")
  if (parts.length === 0) return null

  parts.push(key.length === 1 ? key.toUpperCase() : key)
  return parts.join("+")
}

/** Two accelerators collide when they'd fire on the same keypress. */
export function acceleratorsEqual(a: string, b: string): boolean {
  const pa = parseAccelerator(a)
  const pb = parseAccelerator(b)
  if (pa == null || pb == null) return false
  return (
    pa.code === pb.code &&
    pa.mod === pb.mod &&
    pa.ctrl === pb.ctrl &&
    pa.shift === pb.shift &&
    pa.alt === pb.alt
  )
}
