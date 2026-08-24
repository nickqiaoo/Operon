import { getAllPanels, useTabsStore } from "@/stores/tabs-store"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useBrowserScopeStore } from "@/stores/browser-scope-store"
import { useEditorStore } from "@/stores/editor-store"
import { browserManager } from "./BrowserManager"

/**
 * The renderer side of Browser Use: the main process's IAB backend asks us to
 * open and close browser tabs.
 *
 * This layer exists because the backend and driver run in the main process
 * (`electron/browser-use-driver.ts`, since `webContents.debugger` lives there),
 * while opening and closing tabs has to happen in the renderer, where the tabs
 * store is. The existing IPC only offers renderer-to-main (invoke/handle) and
 * one-way main-to-renderer pushes, so `browser-use:request` and `:response`
 * correlated by reqId make up a request/response channel.
 *
 * What goes back to the main process is the instanceId, not the webContents id.
 * The latter is registered by `WebviewInstance` when the <webview> fires
 * `dom-ready`, and the main process waits for it to appear.
 */

/** Kept in step with how `tab-entries.ts` generates browser tab ids. */
const newInstanceId = () => Math.random().toString(36).slice(2, 8)

/** A browser tab can only live in the right or bottom panel. */
function findBrowserTab(instanceId: string) {
  const s = useTabsStore.getState()
  for (const panel of ["right", "bottom"] as const) {
    const tab = s[panel].tabs.find(
      (t) => t.payload?.type === "browser" && t.payload.instanceId === instanceId
    )
    if (tab) return { panel, tabId: tab.tabId }
  }
  return null
}

function activeBrowserInstanceIds(): string[] {
  const activeIds: string[] = []
  // Include parked workspaces too. A tab remains selected in its conversation's
  // browser even when that workspace is not currently presented.
  for (const panel of getAllPanels()) {
    const groups = new Map<string, typeof panel.tabs>()
    for (const tab of panel.tabs) {
      if (tab.payload.type !== "browser") continue
      const key = tab.payload.chatId == null ? "ownerless" : String(tab.payload.chatId)
      const group = groups.get(key) ?? []
      group.push(tab)
      groups.set(key, group)
    }
    for (const tabs of groups.values()) {
      const selected = tabs.find((tab) => tab.tabId === panel.activeTabId) ?? tabs[tabs.length - 1]
      if (selected?.payload.type === "browser") {
        activeIds.push(selected.payload.instanceId)
      }
    }
  }
  return activeIds
}

/** Install the bridge and return its teardown. Called once at app startup. */
export function installBrowserUseBridge(): () => void {
  const api = window.electronAPI?.browser
  if (api?.onRequest == null || api.respond == null) return () => {}

  return api.onRequest(async (req) => {
    try {
      const result = await handle(req.action, req.payload)
      api.respond({ id: req.id, ok: true, result })
    } catch (e) {
      api.respond({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  })
}

async function handle(action: string, payload: unknown): Promise<unknown> {
  const { openTab, closeTab } = useTabsStore.getState()

  if (action === "createTab") {
    // `chatId` = the agent's session — the new page lands in **that conversation's**
    // browser panel (the panel switches with the conversation, so pages have owners).
    const { url, chatId } = (payload ?? {}) as { url?: string; chatId?: string }
    const instanceId = newInstanceId()
    const owner = chatId == null ? undefined : Number(chatId)
    const initialUrl = url ?? ""

    // Browser Use owns the guest lifecycle; the panel only presents it. Create the
    // detached <webview> before touching the tabs store so a closed panel or an
    // inactive conversation can still register webContents and serve CDP.
    browserManager.ensure(instanceId, initialUrl, chatId)
    openTab(
      "right",
      {
        tabId: `browser:${instanceId}`,
        title: "New tab",
        isClosable: true,
        // Empty url → the browser opens on the local-servers landing page
        // (same shape as the "Browser" entry in tab-entries.ts).
        payload: {
          type: "browser",
          instanceId,
          url: initialUrl,
          ...(Number.isFinite(owner) ? { chatId: owner } : {}),
        },
      },
      // Creating a tab for a background conversation must not steal the visible
      // panel selection. It is still the selected tab inside its own owner group
      // (activeBrowserInstanceIds falls back to that group's newest tab).
      { activate: owner == null || owner === useBrowserScopeStore.getState().chatId }
    )
    return instanceId
  }

  if (action === "closeTab") {
    const { instanceId } = (payload ?? {}) as { instanceId?: string }
    if (typeof instanceId !== "string") throw new Error("closeTab requires instanceId")
    const found = findBrowserTab(instanceId)
    // Already gone (user closed it first) — that's success, not an error.
    if (found == null) return null
    closeTab(found.panel, found.tabId)
    return null
  }

  if (action === "setCaptureSurface") {
    const { instanceId, size } = (payload ?? {}) as {
      instanceId?: string
      size?: unknown
    }
    if (typeof instanceId !== "string") {
      throw new Error("setCaptureSurface requires instanceId")
    }
    if (size === null) {
      browserManager.setCaptureSurface(instanceId, null)
      return null
    }
    if (typeof size !== "object" || size == null || Array.isArray(size)) {
      throw new Error("setCaptureSurface requires a size or null")
    }
    const { width, height } = size as { width?: unknown; height?: unknown }
    if (typeof width !== "number" || typeof height !== "number") {
      throw new Error("setCaptureSurface requires numeric width and height")
    }
    browserManager.setCaptureSurface(instanceId, { width, height })
    return null
  }

  if (action === "setBrowserUseActive") {
    const { instanceId, active } = (payload ?? {}) as {
      instanceId?: string
      active?: unknown
    }
    if (typeof instanceId !== "string") {
      throw new Error("setBrowserUseActive requires instanceId")
    }
    if (typeof active !== "boolean") {
      throw new Error("setBrowserUseActive requires a boolean active value")
    }
    browserManager.setBrowserUseActive(instanceId, active)
    return null
  }

  if (action === "setBrowserUseCursor") {
    const { instanceId, cursor } = (payload ?? {}) as {
      instanceId?: string
      cursor?: unknown
    }
    if (typeof instanceId !== "string") {
      throw new Error("setBrowserUseCursor requires instanceId")
    }
    if (cursor === null) {
      browserManager.setBrowserUseCursor(instanceId, null)
      return null
    }
    if (typeof cursor !== "object" || cursor == null || Array.isArray(cursor)) {
      throw new Error("setBrowserUseCursor requires a cursor or null")
    }
    const { x, y } = cursor as { x?: unknown; y?: unknown }
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      throw new Error("setBrowserUseCursor requires finite x and y")
    }
    browserManager.setBrowserUseCursor(instanceId, { x, y })
    return null
  }

  if (action === "setBrowserViewport") {
    const { instanceId, size } = (payload ?? {}) as {
      instanceId?: string
      size?: unknown
    }
    if (typeof instanceId !== "string") {
      throw new Error("setBrowserViewport requires instanceId")
    }
    if (size === null) {
      browserManager.setBrowserUseViewport(instanceId, null)
      return null
    }
    if (typeof size !== "object" || size == null || Array.isArray(size)) {
      throw new Error("setBrowserViewport requires a size or null")
    }
    const { width, height } = size as { width?: unknown; height?: unknown }
    if (typeof width !== "number" || typeof height !== "number") {
      throw new Error("setBrowserViewport requires numeric width and height")
    }
    browserManager.setBrowserUseViewport(instanceId, { width, height })
    return null
  }

  if (action === "getTabPresentation") {
    return { activeInstanceIds: activeBrowserInstanceIds() }
  }

  if (action === "selectTab") {
    const { instanceId } = (payload ?? {}) as { instanceId?: string }
    if (typeof instanceId !== "string") throw new Error("selectTab requires instanceId")
    const found = findBrowserTab(instanceId)
    if (found != null) useTabsStore.getState().activateTab(found.panel, found.tabId)
    return null
  }

  if (action === "getBrowserVisibility") {
    const { instanceId } = (payload ?? {}) as { instanceId?: string }
    if (typeof instanceId !== "string") {
      throw new Error("getBrowserVisibility requires instanceId")
    }
    const found = findBrowserTab(instanceId)
    if (found == null) return false
    const state = useTabsStore.getState()
    const tab = state[found.panel].tabs.find((item) => item.tabId === found.tabId)
    if (tab?.payload.type !== "browser") return false
    const scope = useBrowserScopeStore.getState().chatId
    const inScope = tab.payload.chatId == null || tab.payload.chatId === scope
    const selected = activeBrowserInstanceIds().includes(instanceId)
    const panelOpen = found.panel === "right"
      ? useAppShellStore.getState().rightPanelOpen
      : useAppShellStore.getState().bottomPanelOpen
    return inScope && selected && panelOpen
  }

  if (action === "setBrowserVisibility") {
    const { instanceId, visible } = (payload ?? {}) as {
      instanceId?: string
      visible?: unknown
    }
    if (typeof instanceId !== "string" || typeof visible !== "boolean") {
      throw new Error("setBrowserVisibility requires instanceId and visible")
    }
    const found = findBrowserTab(instanceId)
    if (found == null) throw new Error(`Unknown browser instance: ${instanceId}`)
    if (visible) {
      const tab = useTabsStore.getState()[found.panel].tabs.find(
        (item) => item.tabId === found.tabId
      )
      if (tab?.payload.type === "browser" && tab.payload.chatId != null) {
        const chatId = tab.payload.chatId
        const editor = useEditorStore.getState()
        const chatTab = editor.tabs.find((item) => item.chatId === chatId)
        if (chatTab != null) editor.setActiveTab(chatTab.id)
      }
      useTabsStore.getState().activateTab(found.panel, found.tabId)
      if (found.panel === "right") useAppShellStore.getState().setRightPanelOpen(true)
      else useAppShellStore.getState().setBottomPanelOpen(true)
    } else if (await handle("getBrowserVisibility", { instanceId })) {
      if (found.panel === "right") useAppShellStore.getState().setRightPanelOpen(false)
      else useAppShellStore.getState().setBottomPanelOpen(false)
    }
    return null
  }

  throw new Error(`Unknown browser-use action: ${action}`)
}
