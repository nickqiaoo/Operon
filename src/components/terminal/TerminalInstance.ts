import { Terminal as Xterm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { api } from "@/lib/api"
import { useThemeStore } from "@/stores/theme-store"
import { useTerminalThemeStore } from "@/stores/terminal-theme-store"
import {
  DEFAULT_DARK_TERMINAL_THEME,
  DEFAULT_LIGHT_TERMINAL_THEME,
  getTerminalTheme,
} from "@/lib/terminal-themes"

export type TerminalStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "exited"
  | "error"

export interface TerminalState {
  status: TerminalStatus
  statusDetail: string | null
}

export interface TerminalBounds {
  x: number
  y: number
  width: number
  height: number
}

type Listener = (state: TerminalState) => void
type CsiParams = (number | number[])[]

// The xterm container lives at body level, so its z-index competes directly
// with the host's body-level portals (Radix dialogs/menus like the new-tab
// dropdown and the provider picker, the full-screen pages — all z-50). We sit
// just below them (40): high enough to paint over the in-tree placeholder it
// overlays, low enough that any host overlay naturally covers it via normal
// stacking. Using a max z-index here (the old value) made the terminal cover
// the new-tab dropdown and provider-picker dialog, so "New chat" was
// unclickable while a terminal tab was active. Mirrors WebviewInstance.
const Z_INDEX = "40"
const HIDDEN_KEEPALIVE_OPACITY = "0.001"
// How long bounds must hold still before we spawn the PTY. Long enough to
// outlast the panel animations that drive resizes, short enough to read as
// instant. See TerminalInstance.scheduleConnect.
const CONNECT_SETTLE_MS = 80
const IS_WEB = __APP_TARGET__ === "web"

const MODE_NOT_RECOGNIZED = 0
const MODE_SET = 1
const MODE_RESET = 2
const MODE_PERMANENTLY_SET = 3
const MODE_PERMANENTLY_RESET = 4

// Detached container kept at a real (but offscreen) size so xterm can measure
// font cell dimensions on open(). 1×1 hidden would make the renderer compute
// zero cols/rows and leave the terminal blank until the next fit — the user
// sees "blank for a few seconds" before content appears. 800×400 gives xterm
// enough to compute a sane initial 80×24 grid that PTY can write into
// immediately.
const detachedStyles: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  left: "-10000px",
  top: "0",
  width: "800px",
  height: "400px",
  visibility: "hidden",
  opacity: "0",
  pointerEvents: "none",
  zIndex: Z_INDEX,
}

/**
 * One persistent terminal session — xterm + server-side PTY, both kept alive
 * even when the React tab unmounts (so closing the bottom panel doesn't kill
 * running shells). The container lives in document.body, positioned `fixed`
 * to overlay the placeholder div rendered by TerminalTab.
 *
 * Mirrors WebviewInstance's structure 1:1.
 */
export class TerminalInstance {
  readonly instanceId: string
  readonly container: HTMLDivElement
  private readonly xterm: Xterm
  private readonly fitAddon: FitAddon
  private readonly cwd: string | undefined
  /** Logical launcher (e.g. "claude"). Server resolves it to the CLI binary. */
  private readonly launch: string | undefined
  private terminalId: string | null = null
  private state: TerminalState = { status: "idle", statusDetail: null }
  private readonly listeners = new Set<Listener>()
  private dataUnsub: (() => void) | null = null
  private exitUnsub: (() => void) | null = null
  private dataHandler: { dispose(): void } | null = null
  private themeUnsub: (() => void) | null = null
  private terminalThemeUnsub: (() => void) | null = null
  private mediaQuery: MediaQueryList | null = null
  private mediaQueryHandler: ((e: MediaQueryListEvent) => void) | null = null
  private disposed = false
  /** Becomes true once we have real bounds and have called connect() once. */
  private connectStarted = false
  /** Pending settle timer for the deferred spawn — see scheduleConnect(). */
  private connectTimer: number | null = null
  private lastSentCols = -1
  private lastSentRows = -1
  /**
   * Size measured while the spawn request was still in flight, so we had no id
   * to resize. Pushed the moment the id lands — dropping it would leave the pty
   * wider than the terminal, which is exactly what strands zsh's `%` marker.
   */
  private pendingResize: { cols: number; rows: number } | null = null

  constructor({
    instanceId,
    cwd,
    launch,
  }: {
    instanceId: string
    cwd: string | undefined
    launch?: string
  }) {
    this.instanceId = instanceId
    this.cwd = cwd
    this.launch = launch

    this.container = document.createElement("div")
    this.container.dataset.terminalInstanceId = instanceId
    Object.assign(this.container.style, detachedStyles)
    document.body.append(this.container)

    const initialTheme = this.buildTheme()
    // applyTheme() only runs on theme *changes*, so seed the inset colour here.
    this.paintContainerBackground(initialTheme.background)

    this.xterm = new Xterm({
      fontFamily:
        '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      // xterm defaults to a full-cell block; a bar matches the system terminal
      // and every other text field in the app.
      cursorStyle: "bar",
      cursorWidth: 2,
      scrollback: 2000,
      allowTransparency: true,
      allowProposedApi: IS_WEB,
      theme: initialTheme,
    })
    this.fitAddon = new FitAddon()
    this.xterm.loadAddon(this.fitAddon)
    if (IS_WEB) this.installWebRequestModeHandler()
    this.xterm.open(this.container)

    // Re-theme on app light/dark switch and on terminal-theme selection change.
    this.themeUnsub = useThemeStore.subscribe(() => this.applyTheme())
    this.terminalThemeUnsub = useTerminalThemeStore.subscribe(() =>
      this.applyTheme(),
    )
    this.mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    this.mediaQueryHandler = () => {
      if (useThemeStore.getState().theme === "system") this.applyTheme()
    }
    this.mediaQuery.addEventListener("change", this.mediaQueryHandler)

    // PTY spawn is deferred until positionVisible — see connect() comment.
  }

  positionVisible(bounds: TerminalBounds): void {
    if (this.disposed) return
    if (bounds.width <= 0 || bounds.height <= 0) {
      this.positionHidden()
      return
    }
    Object.assign(this.container.style, {
      position: "fixed",
      left: `${bounds.x}px`,
      top: `${bounds.y}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
      visibility: "visible",
      opacity: "1",
      pointerEvents: "auto",
      zIndex: Z_INDEX,
      transform: "",
      contain: "",
    } satisfies Partial<CSSStyleDeclaration>)
    // First time we have real bounds: wait for them to hold still, then spawn
    // at the size we'll actually keep (see scheduleConnect).
    if (!this.connectStarted) {
      this.scheduleConnect()
    } else {
      this.fitAndPushResize()
    }
  }

  positionHidden(): void {
    if (this.disposed) return
    // `contain: size` below makes the container unmeasurable, so a spawn that
    // fires now would fit against nothing. Re-scheduled when we're shown again.
    this.cancelScheduledConnect()
    Object.assign(this.container.style, {
      visibility: "visible",
      opacity: HIDDEN_KEEPALIVE_OPACITY,
      pointerEvents: "none",
      contain: "layout paint size style",
      transform: "translate3d(0, 0, 0)",
    } satisfies Partial<CSSStyleDeclaration>)
  }

  positionDetached(): void {
    if (this.disposed) return
    this.cancelScheduledConnect()
    Object.assign(this.container.style, detachedStyles)
  }

  focus(): void {
    if (this.disposed) return
    this.xterm.focus()
  }

  getState(): TerminalState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelScheduledConnect()
    this.dataHandler?.dispose()
    this.dataUnsub?.()
    this.exitUnsub?.()
    this.themeUnsub?.()
    this.terminalThemeUnsub?.()
    if (this.mediaQuery != null && this.mediaQueryHandler != null) {
      this.mediaQuery.removeEventListener("change", this.mediaQueryHandler)
    }
    if (this.terminalId != null) {
      void api.closeTerminal(this.terminalId)
    }
    try {
      this.xterm.dispose()
    } catch {
      // ignore
    }
    try {
      this.container.remove()
    } catch {
      // ignore
    }
    this.listeners.clear()
  }

  // ------------------------------------------------------------------------

  private updateState(patch: Partial<TerminalState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }

  private buildTheme() {
    // Pick the user's chosen terminal theme for the app's current light/dark
    // mode (selected in Settings → Appearance, persisted per mode).
    const isDark = document.documentElement.classList.contains("dark")
    const store = useTerminalThemeStore.getState()
    const id = isDark ? store.darkTheme : store.lightTheme
    const palette = getTerminalTheme(id).palette
    // The house themes are meant to read as part of the app surface, not as a
    // panel sitting on it, so they take their background from the live UI token
    // rather than a baked hex — otherwise picking any other UI theme
    // (ui-themes.ts) leaves the terminal a visibly different shade. Ported
    // themes (Dracula, Nord, …) keep their own background; that's the point.
    const isHouseTheme =
      id === DEFAULT_LIGHT_TERMINAL_THEME || id === DEFAULT_DARK_TERMINAL_THEME
    if (!isHouseTheme) return palette
    const bg = getComputedStyle(document.documentElement)
      .getPropertyValue("--color-background")
      .trim()
    // Empty means the var isn't resolvable yet — fall back to the baked hex.
    return bg.length > 0 ? { ...palette, background: bg, cursorAccent: bg } : palette
  }

  private applyTheme(): void {
    if (this.disposed) return
    // Defer so the .dark class on <html> is applied before reading CSS vars.
    requestAnimationFrame(() => {
      if (this.disposed) return
      const theme = this.buildTheme()
      this.xterm.options.theme = theme
      this.paintContainerBackground(theme.background)
    })
  }

  /**
   * The `.xterm` padding (globals.css) leaves a gap the renderer never draws
   * into, so the container shows through it. Give it the terminal's own
   * background or a dark theme ends up framed in a pale app-coloured border.
   */
  private paintContainerBackground(background: string | undefined): void {
    this.container.style.backgroundColor = background ?? ""
  }

  private installWebRequestModeHandler(): void {
    // OpenCode/Copilot query terminal modes via DECRQM. The xterm 6 production
    // web bundle can throw inside its default requestMode handler, so answer the
    // query here and stop before the default handler runs.
    this.xterm.parser.registerCsiHandler(
      { intermediates: "$", final: "p" },
      (params) => this.handleRequestMode(params, true),
    )
    this.xterm.parser.registerCsiHandler(
      { prefix: "?", intermediates: "$", final: "p" },
      (params) => this.handleRequestMode(params, false),
    )
  }

  private handleRequestMode(params: CsiParams, ansi: boolean): boolean {
    const mode = this.getFirstNumericParam(params)
    const value = ansi
      ? this.getAnsiModeReport(mode)
      : this.getPrivateModeReport(mode)
    this.xterm.input(`\x1b[${ansi ? "" : "?"}${mode};${value}$y`, false)
    return true
  }

  private getFirstNumericParam(params: CsiParams): number {
    const first = params[0]
    if (typeof first === "number") return first
    const nestedFirst = first?.[0]
    return typeof nestedFirst === "number" ? nestedFirst : 0
  }

  private getAnsiModeReport(mode: number): number {
    if (mode === 2) return MODE_PERMANENTLY_RESET
    if (mode === 4) return this.modeValue(this.xterm.modes.insertMode)
    if (mode === 12) return MODE_PERMANENTLY_SET
    if (mode === 20) return this.modeValue(this.xterm.options.convertEol)
    return MODE_NOT_RECOGNIZED
  }

  private getPrivateModeReport(mode: number): number {
    const modes = this.xterm.modes
    const mouseTracking = modes.mouseTrackingMode

    switch (mode) {
      case 1:
        return this.modeValue(modes.applicationCursorKeysMode)
      case 3:
        if (!this.xterm.options.windowOptions?.setWinLines) {
          return MODE_NOT_RECOGNIZED
        }
        if (this.xterm.cols === 80) return MODE_RESET
        if (this.xterm.cols === 132) return MODE_SET
        return MODE_NOT_RECOGNIZED
      case 6:
        return this.modeValue(modes.originMode)
      case 7:
        return this.modeValue(modes.wraparoundMode)
      case 8:
        return MODE_PERMANENTLY_SET
      case 9:
        return this.modeValue(mouseTracking === "x10")
      case 12:
        return this.modeValue(this.xterm.options.cursorBlink)
      case 25:
        return MODE_SET
      case 45:
        return this.modeValue(modes.reverseWraparoundMode)
      case 66:
        return this.modeValue(modes.applicationKeypadMode)
      case 67:
        return MODE_PERMANENTLY_RESET
      case 1000:
        return this.modeValue(mouseTracking === "vt200")
      case 1002:
        return this.modeValue(mouseTracking === "drag")
      case 1003:
        return this.modeValue(mouseTracking === "any")
      case 1004:
        return this.modeValue(modes.sendFocusMode)
      case 1005:
        return MODE_PERMANENTLY_RESET
      case 1006:
      case 1015:
      case 1016:
        return MODE_PERMANENTLY_RESET
      case 1048:
        return MODE_SET
      case 47:
      case 1047:
      case 1049:
        return this.modeValue(this.xterm.buffer.active.type === "alternate")
      case 2004:
        return this.modeValue(modes.bracketedPasteMode)
      case 2026:
        return this.modeValue(modes.synchronizedOutputMode)
      default:
        return MODE_NOT_RECOGNIZED
    }
  }

  private modeValue(value: boolean | undefined): number {
    return value ? MODE_SET : MODE_RESET
  }

  private fitAndPushResize(): void {
    try {
      this.fitAddon.fit()
    } catch {
      return
    }
    const cols = this.xterm.cols || 80
    const rows = this.xterm.rows || 24
    const id = this.terminalId
    if (id == null) {
      // Spawn still in flight — fit() already resized xterm, so stash the size
      // and let connect() push it once there's an id to push it to.
      this.pendingResize = { cols, rows }
      return
    }
    // Skip duplicate resizes — every SIGWINCH causes zsh to redraw and may
    // emit PROMPT_SP markers, so don't trigger one if the size is unchanged.
    if (cols === this.lastSentCols && rows === this.lastSentRows) return
    this.lastSentCols = cols
    this.lastSentRows = rows
    void api.resizeTerminal(id, cols, rows)
  }

  /**
   * Spawn once the bounds stop moving.
   *
   * Panel open/close animations drive `setBounds` every frame, so the first
   * bounds we see are mid-animation and usually wider than the terminal ends up
   * being. Spawning there hands the pty a width the terminal won't keep, and
   * zsh draws its first prompt at that stale width: its PROMPT_SP probe (`%`
   * padded to the pty's column count) then wraps a line early in the narrower
   * terminal, so the `\e[J` that was meant to erase it starts one row too low
   * and the `%` is stranded at the top of the buffer forever.
   *
   * Each new bounds restarts the timer, so we spawn one settle window after the
   * last change — with the right size, and no marker.
   */
  private scheduleConnect(): void {
    if (this.connectTimer != null) window.clearTimeout(this.connectTimer)
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null
      if (this.disposed || this.connectStarted) return
      this.connectStarted = true
      try {
        this.fitAddon.fit()
      } catch {
        // ignore — connect() falls back to 80x24
      }
      this.connect(this.cwd)
    }, CONNECT_SETTLE_MS)
  }

  /** Drop a spawn that hasn't fired yet — the terminal went away or hid. */
  private cancelScheduledConnect(): void {
    if (this.connectTimer == null) return
    window.clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  private connect(cwd: string | undefined): void {
    this.updateState({ status: "connecting", statusDetail: null })
    const cols = this.xterm.cols || 80
    const rows = this.xterm.rows || 24
    // Record what we spawned with so a same-size fit later won't trigger an
    // unnecessary SIGWINCH (see fitAndPushResize).
    this.lastSentCols = cols
    this.lastSentRows = rows

    api
      .createTerminal({ cwd, cols, rows, launch: this.launch })
      .then(({ id, launchCommand }) => {
        if (this.disposed) {
          void api.closeTerminal(id)
          return
        }
        this.terminalId = id
        this.updateState({ status: "connected", statusDetail: null })
        // A resize measured while the spawn was in flight had no id to go to.
        // Push it now so the pty can't stay wider than the terminal.
        const pending = this.pendingResize
        this.pendingResize = null
        if (pending != null && (pending.cols !== this.lastSentCols || pending.rows !== this.lastSentRows)) {
          this.lastSentCols = pending.cols
          this.lastSentRows = pending.rows
          void api.resizeTerminal(id, pending.cols, pending.rows)
        }
        this.dataHandler = this.xterm.onData((data) => {
          if (this.terminalId === id) {
            void api.writeTerminal(id, data)
          }
        })

        // When a launcher is set (e.g. Claude), type the resolved command into
        // the shell once it emits its first output — by then the prompt is
        // ready, so the command isn't swallowed by shell init.
        let launchSent = false
        this.dataUnsub = api.onTerminalData((incomingId, data) => {
          if (incomingId !== id) return
          this.xterm.write(data)
          if (launchCommand && !launchSent) {
            launchSent = true
            void api.writeTerminal(id, `${launchCommand}\n`)
          }
        })
        this.exitUnsub = api.onTerminalExit((incomingId, exit) => {
          if (incomingId !== id) return
          this.updateState({
            status: "exited",
            statusDetail: `exit ${exit.exitCode}${
              exit.signal != null ? ` signal ${exit.signal}` : ""
            }`,
          })
        })
      })
      .catch((err) => {
        if (this.disposed) return
        console.error("TerminalInstance: failed to create", err)
        this.updateState({
          status: "error",
          statusDetail: err instanceof Error ? err.message : "Failed to start shell",
        })
      })
  }
}
