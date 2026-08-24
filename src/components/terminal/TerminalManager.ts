import { useTabsStore, getAllPanels } from "@/stores/tabs-store"
import { useEditorStore } from "@/stores/editor-store"
import {
  TerminalInstance,
  type TerminalBounds,
} from "./TerminalInstance"

/**
 * Singleton terminal manager. Same lifecycle pattern as BrowserManager:
 *
 *   - instances live in document.body so they survive React unmounts
 *     (panel close, tab inactive, tab transfer)
 *   - `setBounds` is driven by the TerminalTab placeholder's ResizeObserver
 *   - `setVisible` toggles positioned ↔ detached
 *   - Subscribing to useTabsStore reaps instances whose tab disappeared,
 *     which is the only place dispose actually happens
 */
class TerminalManagerImpl {
  private readonly instances = new Map<string, TerminalInstance>()
  private readonly visibilityState = new Map<string, boolean>()
  private readonly boundsState = new Map<string, TerminalBounds>()

  constructor() {
    if (typeof window === "undefined") return
    window.addEventListener("focus", this.resyncAll)
    document.addEventListener("visibilitychange", this.onVisibilityChange)
    useTabsStore.subscribe(this.reapOrphans)
  }

  ensure(instanceId: string, cwd: string | undefined, launch?: string): TerminalInstance {
    let instance = this.instances.get(instanceId)
    if (instance != null) return instance
    instance = new TerminalInstance({ instanceId, cwd, launch })
    this.instances.set(instanceId, instance)
    return instance
  }

  get(instanceId: string): TerminalInstance | null {
    return this.instances.get(instanceId) ?? null
  }

  setBounds(instanceId: string, bounds: TerminalBounds): void {
    const instance = this.instances.get(instanceId)
    if (instance == null) return
    this.boundsState.set(instanceId, bounds)
    if (this.visibilityState.get(instanceId) === true) {
      instance.positionVisible(bounds)
    }
  }

  setVisible(instanceId: string, visible: boolean): void {
    const instance = this.instances.get(instanceId)
    if (instance == null) return
    this.visibilityState.set(instanceId, visible)
    if (visible) {
      const last = this.boundsState.get(instanceId)
      if (last != null) {
        instance.positionVisible(last)
      } else {
        instance.positionHidden()
      }
      instance.focus()
    } else {
      instance.positionDetached()
    }
  }

  dispose(instanceId: string): void {
    const instance = this.instances.get(instanceId)
    if (instance == null) return
    instance.dispose()
    this.instances.delete(instanceId)
    this.visibilityState.delete(instanceId)
    this.boundsState.delete(instanceId)
  }

  // ------------------------------------------------------------------------

  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "visible") this.resyncAll()
  }

  private readonly resyncAll = () => {
    for (const [id, instance] of this.instances) {
      const visible = this.visibilityState.get(id) ?? false
      if (visible) {
        const last = this.boundsState.get(id)
        if (last != null) instance.positionVisible(last)
      } else {
        instance.positionDetached()
      }
    }
  }

  private readonly reapOrphans = () => {
    const liveIds = new Set<string>()
    // All workspaces' panels, not just the active one — switching projects
    // must not dispose terminals belonging to a still-open inactive workspace.
    for (const panel of getAllPanels()) {
      for (const tab of panel.tabs) {
        if (tab.payload.type === "terminal") {
          liveIds.add(tab.payload.terminalId)
        }
      }
    }
    // Editor-area terminal tabs live in editor-store (per-workspace), not the
    // panel store. Include them — current workspace + every saved workspace —
    // so switching panels/workspaces doesn't reap a still-open editor terminal.
    const editor = useEditorStore.getState()
    const editorTabSets = [
      editor.tabs,
      ...Object.values(editor.workspaceStates).map((s) => s.tabs),
    ]
    for (const tabSet of editorTabSets) {
      for (const tab of tabSet) {
        if (tab.type === "terminal" && tab.terminalId != null) {
          liveIds.add(tab.terminalId)
        }
      }
    }
    for (const id of Array.from(this.instances.keys())) {
      if (!liveIds.has(id)) this.dispose(id)
    }
  }
}

export const terminalManager = new TerminalManagerImpl()
