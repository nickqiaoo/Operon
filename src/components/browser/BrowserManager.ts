import { useTabsStore, getAllPanels } from "@/stores/tabs-store"
import {
  WebviewInstance,
  type WebviewBounds,
  type WebviewSyncOptions,
} from "./WebviewInstance"

/**
 * Singleton manager for browser webviews. Each instance lives in a fixed-
 * position container appended to document.body, so it survives React unmounts
 * of the BrowserTab component (panel close, tab inactive, etc.).
 *
 * Lifecycle:
 *   - `ensure(id, url)` — lazy create
 *   - `setBounds(id, rect, opts)` — drive position from the placeholder div
 *   - `setVisible(id, true|false)` — toggle between positioned + detached
 *   - `dispose(id)` — kill the webContents (called when a tab closes)
 *
 * Tab-lifecycle integration: on construction the manager subscribes to
 * useTabsStore and disposes any instance whose corresponding tab has
 * disappeared. This way you don't have to explicitly call dispose from
 * BrowserTab — closing the tab in the store does it.
 */
class BrowserManagerImpl {
  private readonly instances = new Map<string, WebviewInstance>()
  /** Last setVisible value per instance so resync can restore it. */
  private readonly visibilityState = new Map<string, boolean>()
  /** Last bounds per instance so resync can restore position. */
  private readonly boundsState = new Map<
    string,
    { bounds: WebviewBounds; opts: WebviewSyncOptions }
  >()
  /** Browser Use screenshot override; takes precedence over normal tab visibility. */
  private readonly captureSurfaceState = new Map<
    string,
    { width: number; height: number }
  >()
  /** Leased Browser Use tabs keep painting even when their conversation is in the background. */
  private readonly browserUseActiveState = new Set<string>()
  private readonly browserUseViewportState = new Map<
    string,
    { width: number; height: number }
  >()
  constructor() {
    if (typeof window === "undefined") return
    window.addEventListener("focus", this.resyncAll)
    document.addEventListener("visibilitychange", this.onVisibilityChange)
    // Reap orphaned webviews whenever the tab store changes.
    useTabsStore.subscribe(this.reapOrphans)
  }

  ensure(instanceId: string, initialUrl: string, owner?: string): WebviewInstance {
    let instance = this.instances.get(instanceId)
    if (instance != null) return instance
    instance = new WebviewInstance({ instanceId, initialUrl, owner })
    this.instances.set(instanceId, instance)
    return instance
  }

  get(instanceId: string): WebviewInstance | null {
    return this.instances.get(instanceId) ?? null
  }

  setBounds(
    instanceId: string,
    bounds: WebviewBounds,
    opts: WebviewSyncOptions = {}
  ): void {
    const instance = this.instances.get(instanceId)
    if (instance == null) return
    this.boundsState.set(instanceId, { bounds, opts })
    if (
      this.visibilityState.get(instanceId) === true ||
      this.captureSurfaceState.has(instanceId) ||
      this.browserUseActiveState.has(instanceId)
    ) {
      // Capture state must win even if a ResizeObserver fires while the screenshot is pending.
      this.applyVisibility(instanceId, instance)
    }
  }

  setVisible(instanceId: string, visible: boolean): void {
    const instance = this.instances.get(instanceId)
    if (instance == null) return
    this.visibilityState.set(instanceId, visible)
    this.applyVisibility(instanceId, instance)
  }

  /** Temporarily paint a parked webview at an exact size; `null` restores its prior state. */
  setCaptureSurface(
    instanceId: string,
    size: { width: number; height: number } | null
  ): void {
    const instance = this.instances.get(instanceId)
    if (instance == null) throw new Error(`Unknown browser instance: ${instanceId}`)
    if (size == null) {
      this.captureSurfaceState.delete(instanceId)
    } else {
      if (
        !Number.isFinite(size.width) ||
        !Number.isFinite(size.height) ||
        size.width <= 0 ||
        size.height <= 0
      ) {
        throw new Error("Capture surface requires positive finite width and height")
      }
      this.captureSurfaceState.set(instanceId, {
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
      })
    }
    this.applyVisibility(instanceId, instance)
  }

  /** Keep a leased tab on a low-opacity paint host while it is not visible. */
  setBrowserUseActive(instanceId: string, active: boolean): void {
    const instance = this.instances.get(instanceId)
    if (instance == null) throw new Error(`Unknown browser instance: ${instanceId}`)
    if (active) {
      this.browserUseActiveState.add(instanceId)
    } else {
      this.browserUseActiveState.delete(instanceId)
    }
    this.applyVisibility(instanceId, instance)
  }

  setBrowserUseCursor(
    instanceId: string,
    cursor: { x: number; y: number } | null
  ): void {
    const instance = this.instances.get(instanceId)
    if (instance == null) throw new Error(`Unknown browser instance: ${instanceId}`)
    instance.setBrowserUseCursor(cursor)
  }

  setBrowserUseViewport(
    instanceId: string,
    size: { width: number; height: number } | null
  ): void {
    const instance = this.instances.get(instanceId)
    if (instance == null) throw new Error(`Unknown browser instance: ${instanceId}`)
    if (size == null) {
      this.browserUseViewportState.delete(instanceId)
      instance.setBrowserUseViewport(null)
    } else {
      if (
        !Number.isFinite(size.width) ||
        !Number.isFinite(size.height) ||
        size.width <= 0 ||
        size.height <= 0
      ) {
        throw new Error("Browser viewport requires positive finite width and height")
      }
      const normalized = { width: Math.round(size.width), height: Math.round(size.height) }
      this.browserUseViewportState.set(instanceId, normalized)
      instance.setBrowserUseViewport(normalized)
    }
    this.applyVisibility(instanceId, instance)
  }

  dispose(instanceId: string): void {
    const instance = this.instances.get(instanceId)
    if (instance == null) return
    instance.dispose()
    this.instances.delete(instanceId)
    this.visibilityState.delete(instanceId)
    this.boundsState.delete(instanceId)
    this.captureSurfaceState.delete(instanceId)
    this.browserUseActiveState.delete(instanceId)
    this.browserUseViewportState.delete(instanceId)
  }

  disposeAll(): void {
    for (const id of Array.from(this.instances.keys())) this.dispose(id)
  }

  // ------------------------------------------------------------------------

  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "visible") this.resyncAll()
  }

  /** Apply one instance's effective visibility (stored visibility ∧ no modal). */
  private applyVisibility(instanceId: string, instance: WebviewInstance): void {
    const captureSurface = this.captureSurfaceState.get(instanceId)
    if (captureSurface != null) {
      instance.positionCaptureSurface(captureSurface)
      return
    }
    const visible = this.visibilityState.get(instanceId) ?? false
    if (visible) {
      const last = this.boundsState.get(instanceId)
      if (last != null) {
        instance.positionVisible(last.bounds, last.opts)
      } else {
        instance.positionHidden()
      }
      return
    }
    if (this.browserUseActiveState.has(instanceId)) {
      instance.positionHidden()
      return
    }
    instance.positionDetached()
  }

  /**
   * Re-apply each instance's stored visibility + bounds. Needed on window
   * focus / tab visibility regain because Chromium occasionally drops or
   * mis-positions fixed children of body across those transitions.
   */
  private readonly resyncAll = () => {
    for (const [id, instance] of this.instances) {
      this.applyVisibility(id, instance)
    }
  }

  /**
   * Compare manager state to the tabs store; dispose any instance whose tab
   * is no longer present in either panel.
   */
  private readonly reapOrphans = () => {
    const liveIds = new Set<string>()
    // All workspaces' panels, not just the active one — switching projects
    // must not dispose browser instances of a still-open inactive workspace.
    for (const panel of getAllPanels()) {
      for (const tab of panel.tabs) {
        if (tab.payload.type === "browser") {
          liveIds.add(tab.payload.instanceId)
        }
      }
    }
    for (const id of Array.from(this.instances.keys())) {
      if (!liveIds.has(id)) this.dispose(id)
    }
  }
}

export const browserManager = new BrowserManagerImpl()
