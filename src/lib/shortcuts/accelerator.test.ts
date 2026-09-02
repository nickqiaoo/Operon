import { afterEach, describe, expect, it, vi } from "vitest"
import {
  acceleratorFromEvent,
  acceleratorsEqual,
  formatAccelerator,
  matchesAccelerator,
  parseAccelerator,
} from "./accelerator"

/**
 * Both platform branches matter and the suite runs on one machine, so the
 * platform is stubbed rather than inherited: on macOS CmdOrCtrl is ⌘ and a
 * literal Control stays separate; everywhere else the two collapse into Ctrl.
 */
const onPlatform = (platform: string) =>
  vi.stubGlobal("navigator", { platform })

afterEach(() => {
  vi.unstubAllGlobals()
})

const key = (init: Partial<KeyboardEvent> & { code: string }) =>
  ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  }) as KeyboardEvent

describe("parseAccelerator", () => {
  it("parses modifiers and maps the key to a physical code", () => {
    onPlatform("MacIntel")
    expect(parseAccelerator("CmdOrCtrl+Shift+G")).toEqual({
      mod: true,
      ctrl: false,
      shift: true,
      alt: false,
      code: "KeyG",
    })
    expect(parseAccelerator("Control+`")?.code).toBe("Backquote")
    expect(parseAccelerator("CmdOrCtrl+\\")?.code).toBe("Backslash")
    expect(parseAccelerator("CmdOrCtrl+1")?.code).toBe("Digit1")
  })

  it("returns null for junk rather than binding something unprintable", () => {
    expect(parseAccelerator("")).toBeNull()
    expect(parseAccelerator("CmdOrCtrl")).toBeNull()
    expect(parseAccelerator("CmdOrCtrl+F13")).toBeNull()
    // We don't support chords.
    expect(parseAccelerator("CmdOrCtrl+K+P")).toBeNull()
  })
})

describe("matchesAccelerator", () => {
  it("matches on code, so macOS's Option remapping can't break it", () => {
    onPlatform("MacIntel")
    // ⌥S arrives with key "ß" but code "KeyS", which is why we never read `key`.
    expect(
      matchesAccelerator(
        key({ code: "KeyS", metaKey: true, altKey: true }),
        "CmdOrCtrl+Alt+S"
      )
    ).toBe(true)
  })

  it("requires an exact modifier set", () => {
    onPlatform("Win32")
    expect(matchesAccelerator(key({ code: "KeyT", ctrlKey: true }), "CmdOrCtrl+T")).toBe(true)
    // Extra modifiers are a different shortcut, not a looser match.
    expect(
      matchesAccelerator(key({ code: "KeyT", ctrlKey: true, shiftKey: true }), "CmdOrCtrl+T")
    ).toBe(false)
    expect(matchesAccelerator(key({ code: "KeyT" }), "CmdOrCtrl+T")).toBe(false)
  })

  it("keeps a literal Control apart from ⌘ on macOS", () => {
    onPlatform("MacIntel")
    // ⌃` is the terminal binding; ⌘` must not trigger it.
    expect(matchesAccelerator(key({ code: "Backquote", ctrlKey: true }), "Control+`")).toBe(true)
    expect(matchesAccelerator(key({ code: "Backquote", metaKey: true }), "Control+`")).toBe(false)
  })

  it("folds the primary modifier into Control off macOS", () => {
    onPlatform("Win32")
    expect(matchesAccelerator(key({ code: "Backquote", ctrlKey: true }), "Control+`")).toBe(true)
    expect(matchesAccelerator(key({ code: "KeyT", ctrlKey: true }), "CmdOrCtrl+T")).toBe(true)
  })
})

describe("formatAccelerator", () => {
  it("prints macOS symbols in the order macOS uses", () => {
    onPlatform("MacIntel")
    expect(formatAccelerator("CmdOrCtrl+Shift+G")).toBe("⇧⌘G")
    expect(formatAccelerator("Ctrl+Shift+G")).toBe("⌃⇧G")
    expect(formatAccelerator("CmdOrCtrl+Alt+S")).toBe("⌥⌘S")
    expect(formatAccelerator("Control+`")).toBe("⌃`")
  })

  it("spells modifiers out elsewhere", () => {
    onPlatform("Win32")
    expect(formatAccelerator("CmdOrCtrl+Shift+G")).toBe("Ctrl+Shift+G")
    expect(formatAccelerator("Control+`")).toBe("Ctrl+`")
  })

  it("prints nothing for an unparseable binding", () => {
    expect(formatAccelerator("nonsense")).toBe("")
  })
})

describe("acceleratorFromEvent", () => {
  it("records ⌘ as the portable CmdOrCtrl, and ⌃ as itself", () => {
    onPlatform("MacIntel")
    expect(acceleratorFromEvent(key({ code: "KeyG", metaKey: true, shiftKey: true }))).toBe(
      "CmdOrCtrl+Shift+G"
    )
    expect(acceleratorFromEvent(key({ code: "Backquote", ctrlKey: true }))).toBe("Control+`")
  })

  it("records Ctrl as CmdOrCtrl off macOS", () => {
    onPlatform("Win32")
    expect(acceleratorFromEvent(key({ code: "KeyG", ctrlKey: true, shiftKey: true }))).toBe(
      "CmdOrCtrl+Shift+G"
    )
  })

  it("ignores modifier-only and unmodified presses", () => {
    onPlatform("MacIntel")
    expect(acceleratorFromEvent(key({ code: "ShiftLeft", shiftKey: true }))).toBeNull()
    // A bare letter would swallow typing everywhere...
    expect(acceleratorFromEvent(key({ code: "KeyG" }))).toBeNull()
    // ...and so would a merely shifted one.
    expect(acceleratorFromEvent(key({ code: "KeyG", shiftKey: true }))).toBeNull()
  })

  it("round-trips through matchesAccelerator", () => {
    onPlatform("MacIntel")
    const event = key({ code: "KeyP", metaKey: true })
    const recorded = acceleratorFromEvent(event)
    expect(recorded).not.toBeNull()
    expect(matchesAccelerator(event, recorded!)).toBe(true)
  })
})

describe("acceleratorsEqual", () => {
  it("compares by effect, not by spelling", () => {
    onPlatform("MacIntel")
    expect(acceleratorsEqual("CmdOrCtrl+Shift+G", "Shift+CmdOrCtrl+g")).toBe(true)
    expect(acceleratorsEqual("CmdOrCtrl+G", "CmdOrCtrl+Shift+G")).toBe(false)
  })
})
