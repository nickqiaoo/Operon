# Vendored: OpenComputerUseKit

Source: https://github.com/iFurySt/open-codex-computer-use
Commit: 23dd5b1b7c4da99a6fe66daf7c95d9f6ab244930
License: MIT (see ./LICENSE)

Only the single library target
`packages/OpenComputerUseKit/Sources/OpenComputerUseKit` is vendored here: it has
no external SwiftPM dependencies and uses system frameworks only. The upstream
apps, experiments, fixtures and tests are not included.

Operon's changes to the engine are additive, which the MIT licence permits. Each
one is marked with an `[operon]` comment so it stays easy to reconcile with
upstream:

- `ComputerUseService.selectText(...)` plus a `select_text` case in the
  dispatcher. Upstream has no select_text.
- `ComputerUseService.getAppState(disableDiff:)`, `renderAccessibilityDiff(...)`
  and a `lastRenderedByApp` cache, so the default response is a line-level diff of
  the accessibility tree against the current snapshot's index.
- Applications are launched with `NSWorkspace.OpenConfiguration.activates =
  false`, so Computer Use does not pull the target to the foreground.
- Accessibility and screenshot recovery wait passively and use `unhide` and
  `unminimize`, resolving the target from `.optionAll` windows. It no longer calls
  `activate` or `AXRaise`, and no longer writes `AXMain` or `AXFocused`.
- On macOS 26, when `SCScreenshotManager` leaves its continuation unfinished, the
  older `CGWindowListCreateImage` is resolved dynamically as a fallback for
  capturing a window that is not active. If that fails too, an accessibility-only
  state is still returned.

Detecting user takeover, the focus-steal backstop, and the JSON-RPC error codes
live above this directory in `OperonComputerUseServer`, as does the rest of the
wiring: the wire contract, requestType dispatch, and structured list_apps.
