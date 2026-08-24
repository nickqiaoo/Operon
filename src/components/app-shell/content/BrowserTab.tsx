import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle } from "lucide-react"
import { useTabsStore } from "@/stores/tabs-store"
import { browserManager } from "@/components/browser/BrowserManager"
import { BrowserChrome } from "@/components/browser/BrowserChrome"
import { DeviceToolbar } from "@/components/browser/DeviceToolbar"
import { LocalServersLanding } from "@/components/browser/LocalServersLanding"
import type { WebviewState } from "@/components/browser/WebviewInstance"
import type { PanelId } from "@/components/app-shell/tabs/types"

/** No page loaded yet — show the local-servers landing instead of the webview. */
const isLandingUrl = (url: string): boolean => url === "" || url === "about:blank"

interface BrowserTabProps {
  panelId: PanelId
  tabId: string
  instanceId: string
  initialUrl: string
  isActive: boolean
  /** Which conversation's browser this page belongs to (see TabPayload["browser"].chatId). */
  chatId?: number
}

/**
 * Browser sidebar tab. The actual `<webview>` lives outside React (managed
 * by browserManager) so it survives mount/unmount transitions like panel
 * close or tab switch. This component just:
 *
 *   1. ensures the manager has an instance for this ID
 *   2. drives `manager.setBounds` from the placeholder div's bounding rect
 *   3. drives `manager.setVisible` from the tab's active state
 *
 * Disposal is owned by the manager: it watches the tabs store and reaps
 * instances whose tab disappears.
 */
export function BrowserTab({
  panelId,
  tabId,
  instanceId,
  initialUrl,
  isActive,
  chatId,
}: BrowserTabProps) {
  const placeholderRef = useRef<HTMLDivElement | null>(null)
  // ensure() is idempotent — useMemo prevents creating duplicate instances
  // across re-renders while still picking up new IDs if instanceId changes.
  const instance = useMemo(
    // owner (chatId) is baked in at creation, like initialUrl — a page does not
    // change conversations. Browser Use reads it to scope tab visibility.
    () => browserManager.ensure(instanceId, initialUrl, chatId == null ? undefined : String(chatId)),
    // initialUrl/chatId are only used on FIRST creation for this id; ignore later changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instanceId]
  )

  // Track the whole webview state (url drives the landing state, loadError the
  // retry banner, deviceToolbar/zoom the device emulation bar).
  const [wvState, setWvState] = useState<WebviewState>(() => instance.getState())
  useEffect(() => {
    setWvState(instance.getState())
    return instance.subscribe(setWvState)
  }, [instance])

  const url = wvState.url
  const loadError = wvState.loadError
  const isLanding = isLandingUrl(url)

  // Name the tab after the page it is showing. Several browser tabs can be open
  // at once, so a strip of identical "New tab" labels would be unreadable.
  // Falls back to the URL until `page-title-updated` arrives.
  useEffect(() => {
    const title = isLanding ? "New tab" : wvState.title || url
    const store = useTabsStore.getState()
    // updateTab always writes a new tab object; skip the no-op store churn.
    if (store[panelId].tabs.find((t) => t.tabId === tabId)?.title === title) return
    store.updateTab(panelId, tabId, { title })
  }, [panelId, tabId, isLanding, wvState.title, url])

  // Track bounds.
  useEffect(() => {
    const el = placeholderRef.current
    if (el == null) return

    const flush = () => {
      const rect = el.getBoundingClientRect()
      browserManager.setBounds(instanceId, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      })
    }
    flush()

    // The placeholder's own size (when panel resizes) + the panel container's
    // size (when the open/close motion animates) both move the placeholder
    // on screen. Observe both so we catch position changes that ResizeObserver
    // on the placeholder alone would miss.
    const targets = new Set<Element>([el])
    const ancestor = el.closest<HTMLElement>("[data-app-shell-focus-area]")
    if (ancestor != null) targets.add(ancestor)

    const observer = new ResizeObserver(flush)
    for (const target of targets) observer.observe(target)

    // Window resize fires document layout shifts that ResizeObserver may
    // miss on ancestors we don't observe (e.g. the left sidebar).
    const handleWindowResize = () => flush()
    window.addEventListener("resize", handleWindowResize)

    return () => {
      observer.disconnect()
      window.removeEventListener("resize", handleWindowResize)
    }
  }, [instanceId])

  // Drive visibility from isActive — but keep the webview hidden while the
  // landing page is showing (no page loaded), so it doesn't cover the cards.
  useEffect(() => {
    browserManager.setVisible(instanceId, isActive && !isLanding)
    return () => {
      // On unmount (panel close / tab transfer): hide but don't dispose.
      // Real disposal happens via the manager's tabs-store subscription.
      browserManager.setVisible(instanceId, false)
    }
  }, [instanceId, isActive, isLanding])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BrowserChrome instance={instance} />
      {wvState.deviceToolbar && <DeviceToolbar instance={instance} state={wvState} />}
      <div ref={placeholderRef} className="relative min-h-0 flex-1">
        {isLanding && (
          <LocalServersLanding onOpen={(nextUrl) => instance.navigate(nextUrl)} />
        )}
        {loadError != null && (
          <div className="pointer-events-auto absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background px-6 text-center">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            <div className="text-sm font-medium text-foreground">
              Failed to load page
            </div>
            <div className="max-w-md text-xs text-muted-foreground">
              {loadError.description} ({loadError.code})
            </div>
            <div className="max-w-md break-all text-[11px] text-muted-foreground/70">
              {loadError.url}
            </div>
            <button
              type="button"
              onClick={() => instance.navigate(loadError.url)}
              className="mt-1 rounded-md border border-border/50 px-3 py-1 text-xs hover:bg-muted/60"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
