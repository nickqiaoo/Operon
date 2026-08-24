import { useCallback, useEffect, useMemo, useState } from "react"
import { Keyboard } from "@capacitor/keyboard"
import { Toaster } from "sonner"
import { nativePlatform } from "@/lib/native"
import { useAndroidBackButton } from "@/hooks/useAndroidBackButton"
import { useNativeStatusBar } from "@/hooks/useNativeStatusBar"
import { useNativePushNotifications } from "@/hooks/useNativePushNotifications"
import { InboxButton } from "@/components/inbox/InboxButton"
import { useInboxStream } from "@/hooks/useInboxStream"
import type { Notification } from "@/types/notification"
import { useProjectStore } from "@/stores/project-store"
import { useEditorStore } from "@/stores/editor-store"
import { useTabsStore } from "@/stores/tabs-store"
import { useThemeStore, applyTheme } from "@/stores/theme-store"
import { MobileTopBar } from "./MobileTopBar"
import { MobileTabBar, type MobileTab } from "./MobileTabBar"
import { MobileContextSwitcher } from "./MobileContextSwitcher"
import { MobileChatsScreen } from "./MobileChatsScreen"
import { MobileChannelScreen } from "./MobileChannelScreen"
import { MobileReviewScreen } from "./MobileReviewScreen"
import { MobileMoreScreen } from "./MobileMoreScreen"
import { InstallPrompt } from "@/components/web/InstallPrompt"
import { setAnalyticsScreen } from "@/lib/analytics"

type NotificationTarget = Partial<
  Pick<Notification, "chatId" | "taskId" | "projectId" | "workspaceId" | "title">
>

/**
 * Phone shell: top context bar + single-column screen + bottom tab bar.
 * Reuses the desktop stores wholesale (project / editor / tabs / theme) and
 * only owns the layout. Mounted by {@link Root} for web on small viewports;
 * the desktop multi-pane app is left completely untouched.
 */
export function MobileApp() {
  const [tab, setTab] = useState<MobileTab>("chats")
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  // A screen can ask for the full viewport (chat transcript): the context bar
  // and tab bar step aside and the screen carries the safe-area insets itself.
  const [immersive, setImmersive] = useState(false)
  // Pending inbox deep-link: switch to the right tab, then the target screen
  // opens the specific chat/task and clears this via onDeepLinkConsumed.
  const [deepLink, setDeepLink] = useState<{ chatId?: number; taskId?: number; title?: string } | null>(null)

  const projects = useProjectStore((s) => s.projects)
  const activeWorkspaceId = useProjectStore((s) => s.activeWorkspaceId)
  const loadProjects = useProjectStore((s) => s.loadProjects)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const setActiveWorkspace = useProjectStore((s) => s.setActiveWorkspace)
  const setWorkspace = useEditorStore((s) => s.setWorkspace)
  const taskNavRequest = useEditorStore((s) => s.taskNavigationRequest)
  const clearTaskNavRequest = useEditorStore((s) => s.clearTaskNavigationRequest)
  const theme = useThemeStore((s) => s.theme)

  useInboxStream()
  useNativeStatusBar()
  // Last resorts, after every screen has had its turn: close the context
  // sheet, then fall back to Chats, and only then let back exit the app.
  useAndroidBackButton(() => {
    if (switcherOpen) {
      setSwitcherOpen(false)
      return true
    }
    if (tab !== "chats") {
      setTab("chats")
      return true
    }
    return false
  })

  // Deep-link on phone: switch to the surface, set the active project/workspace,
  // then hand the target down so the screen opens the exact task/chat.
  //
  // Structurally typed rather than taking a full `Notification`, because the
  // same routing serves two arrivals: an in-app inbox tap (a real Notification)
  // and a tapped APNs push (only the ids survive the payload round-trip).
  const handleOpenNotification = useCallback((n: NotificationTarget) => {
    if (n.taskId != null) {
      if (n.projectId != null) setActiveProject(n.projectId)
      setTab("channel")
      setDeepLink({ taskId: n.taskId })
    } else if (n.chatId != null) {
      if (n.workspaceId != null) {
        const project = projects.find((p) => p.workspaces.some((w) => w.id === n.workspaceId))
        setActiveWorkspace(n.workspaceId, project?.id ?? null)
      }
      setTab("chats")
      setDeepLink({ chatId: n.chatId, title: n.title })
    }
  }, [projects, setActiveProject, setActiveWorkspace])

  // Tapping a push lands on exactly the same surface as tapping its inbox row.
  useNativePushNotifications(handleOpenNotification)

  // A task card in a chat transcript asked to open that task — mirrors App.tsx's
  // desktop handler, landing on the same surface as an inbox task notification:
  // Channel tab, Tasks view, detail open.
  useEffect(() => {
    if (!taskNavRequest) return
    setActiveProject(taskNavRequest.projectId)
    setTab("channel")
    setDeepLink({ taskId: taskNavRequest.taskId })
    clearTaskNavRequest()
  }, [taskNavRequest, clearTaskNavRequest, setActiveProject])

  // Same reason as the desktop shell: navigation is state, not URL, so the
  // screen has to be reported. `immersive` is the difference between a list and
  // the thing it opened, which is worth keeping separate.
  useEffect(() => {
    setAnalyticsScreen(immersive ? `${tab}-detail` : tab)
  }, [tab, immersive])

  // Theme must be applied here too — on mobile this component renders instead
  // of <App/>, which is where the desktop applies it.
  useEffect(() => {
    applyTheme(theme)
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => {
      if (theme === "system") applyTheme("system")
    }
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [theme])

  useEffect(() => {
    void loadProjects().catch((e) => console.error("Failed to load projects:", e))
  }, [loadProjects])

  // Keep the phone shell locked to the largest known closed height. The keyboard
  // is treated as an overlay: we expose its height via CSS so only the composer
  // moves above it instead of compressing the whole app.
  useEffect(() => {
    const root = document.documentElement
    const body = document.body
    const appRoot = document.getElementById("root")
    const vv = window.visualViewport
    const prev = {
      htmlOverflow: root.style.overflow,
      htmlOverscroll: root.style.overscrollBehavior,
      htmlHeight: root.style.height,
      htmlMinHeight: root.style.minHeight,
      bodyOverflow: body.style.overflow,
      bodyOverscroll: body.style.overscrollBehavior,
      bodyHeight: body.style.height,
      bodyMinHeight: body.style.minHeight,
      appRootHeight: appRoot?.style.height ?? "",
      appRootMinHeight: appRoot?.style.minHeight ?? "",
    }
    const readVisibleHeight = () => Math.max(1, vv?.height ?? window.innerHeight)
    root.style.setProperty("--app-height", `${Math.round(readVisibleHeight())}px`)
    root.style.setProperty("--keyboard-height", "0px")
    root.style.overflow = "hidden"
    root.style.overscrollBehavior = "none"
    root.style.height = "var(--app-height)"
    root.style.minHeight = "var(--app-height)"
    body.style.overflow = "hidden"
    body.style.overscrollBehavior = "none"
    body.style.height = "var(--app-height)"
    body.style.minHeight = "var(--app-height)"
    if (appRoot) {
      appRoot.style.height = "var(--app-height)"
      appRoot.style.minHeight = "var(--app-height)"
    }

    const restore = () => {
      root.style.removeProperty("--app-height")
      root.style.removeProperty("--keyboard-height")
      setKeyboardOpen(false)
      root.style.overflow = prev.htmlOverflow
      root.style.overscrollBehavior = prev.htmlOverscroll
      root.style.height = prev.htmlHeight
      root.style.minHeight = prev.htmlMinHeight
      body.style.overflow = prev.bodyOverflow
      body.style.overscrollBehavior = prev.bodyOverscroll
      body.style.height = prev.bodyHeight
      body.style.minHeight = prev.bodyMinHeight
      if (appRoot) {
        appRoot.style.height = prev.appRootHeight
        appRoot.style.minHeight = prev.appRootMinHeight
      }
    }

    // iOS only. UIKit hands us the keyboard's exact height and animation, so
    // all of the visual-viewport inference below is unnecessary there — and
    // would in fact never fire, because `KeyboardResize.None`
    // (capacitor.config.ts) stops the web view from resizing at all, leaving
    // `visualViewport.height` constant with the keyboard up.
    //
    // Android deliberately keeps the web path. `resize` is an iOS-only option,
    // so the Android web view still resizes for the IME exactly like a mobile
    // browser — which is what the code below already handles. Taking the native
    // branch there would offset the composer twice: once by the shrinking
    // viewport, once by `--keyboard-height`.
    if (nativePlatform() === "ios") {
      // The input accessory bar (the "Done" / prev-next strip UIKit stacks on
      // top of the keyboard) is dead weight in an app with its own composer.
      void Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {})
      const syncShellHeight = () =>
        root.style.setProperty("--app-height", `${Math.round(Math.max(1, window.innerHeight))}px`)
      syncShellHeight()

      const handles = [
        Keyboard.addListener("keyboardWillShow", (info) => {
          root.style.setProperty("--keyboard-height", `${Math.round(info.keyboardHeight)}px`)
          setKeyboardOpen(true)
        }),
        Keyboard.addListener("keyboardWillHide", () => {
          root.style.setProperty("--keyboard-height", "0px")
          setKeyboardOpen(false)
        }),
      ]
      // Rotation is the only thing left that changes the shell's height.
      window.addEventListener("resize", syncShellHeight)
      window.addEventListener("orientationchange", syncShellHeight)

      return () => {
        window.removeEventListener("resize", syncShellHeight)
        window.removeEventListener("orientationchange", syncShellHeight)
        for (const handle of handles) void handle.then((h) => h.remove()).catch(() => {})
        restore()
      }
    }

    let settleTimers: ReturnType<typeof setTimeout>[] = []
    let width = window.innerWidth
    let closedHeight = readVisibleHeight()
    let keyboardVisible = false

    const isEditableFocused = () => {
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return true
      return active instanceof HTMLElement && active.isContentEditable
    }

    const setViewportMetrics = (height: number, keyboardHeight: number) => {
      root.style.setProperty("--app-height", `${Math.round(height)}px`)
      root.style.setProperty("--keyboard-height", `${Math.round(Math.max(0, keyboardHeight))}px`)
      if (window.scrollY !== 0) window.scrollTo(0, 0)
      if (root.scrollTop !== 0) root.scrollTop = 0
      if (body.scrollTop !== 0) body.scrollTop = 0
    }

    const apply = () => {
      const visible = readVisibleHeight()
      const nextWidth = window.innerWidth
      const editableFocused = isEditableFocused()

      if (Math.abs(nextWidth - width) > 48) {
        width = nextWidth
        closedHeight = visible
        keyboardVisible = false
      }

      if (editableFocused) {
        // Before the keyboard opens, keep the baseline aligned with Safari's
        // current visual viewport (including its dynamic browser toolbars).
        if (!keyboardVisible && closedHeight - visible <= 120) {
          closedHeight = visible
        }

        const keyboardHeight = Math.max(0, closedHeight - visible)
        keyboardVisible = keyboardHeight > 120
        setKeyboardOpen(keyboardVisible)
        setViewportMetrics(keyboardVisible ? closedHeight : visible, keyboardVisible ? keyboardHeight : 0)
        return
      }

      // During the keyboard's closing animation, retain the last baseline until
      // the visual viewport has expanded again. Outside that transition, always
      // follow the current visible height so Safari's bottom toolbar cannot cover
      // the composer or tab bar.
      const remainingKeyboardHeight = Math.max(0, closedHeight - visible)
      if (keyboardVisible && remainingKeyboardHeight > 120) {
        setKeyboardOpen(true)
        setViewportMetrics(closedHeight, remainingKeyboardHeight)
        return
      }

      keyboardVisible = false
      closedHeight = visible
      setKeyboardOpen(false)
      setViewportMetrics(visible, 0)
    }

    const clearSettleTimers = () => {
      for (const timer of settleTimers) clearTimeout(timer)
      settleTimers = []
    }

    const restoreClosedHeight = () => {
      requestAnimationFrame(apply)
      clearSettleTimers()
      settleTimers = [80, 250, 700].map((delay) => setTimeout(apply, delay))
    }

    const onOrientationChange = () => {
      width = window.innerWidth
      closedHeight = readVisibleHeight()
      keyboardVisible = false
      apply()
    }

    apply()
    vv?.addEventListener("resize", apply)
    vv?.addEventListener("scroll", apply)
    window.addEventListener("resize", apply)
    window.addEventListener("orientationchange", onOrientationChange)
    document.addEventListener("focusin", apply)
    document.addEventListener("focusout", restoreClosedHeight)

    return () => {
      clearSettleTimers()
      vv?.removeEventListener("resize", apply)
      vv?.removeEventListener("scroll", apply)
      window.removeEventListener("resize", apply)
      window.removeEventListener("orientationchange", onOrientationChange)
      document.removeEventListener("focusin", apply)
      document.removeEventListener("focusout", restoreClosedHeight)
      restore()
    }
  }, [])

  useEffect(() => {
    const preventGestureZoom = (event: Event) => event.preventDefault()
    const options: AddEventListenerOptions = { passive: false }

    document.addEventListener("gesturestart", preventGestureZoom, options)
    document.addEventListener("gesturechange", preventGestureZoom, options)
    document.addEventListener("gestureend", preventGestureZoom, options)

    return () => {
      document.removeEventListener("gesturestart", preventGestureZoom, options)
      document.removeEventListener("gesturechange", preventGestureZoom, options)
      document.removeEventListener("gestureend", preventGestureZoom, options)
    }
  }, [])

  // Keep the per-workspace tab/editor buckets in sync with the active context,
  // mirroring App.tsx so chats are scoped to the selected workspace.
  const activeInfo = useMemo(() => {
    if (activeWorkspaceId == null) return null
    for (const project of projects) {
      const workspace = project.workspaces.find((w) => w.id === activeWorkspaceId)
      if (workspace) return { project, workspace }
    }
    return null
  }, [projects, activeWorkspaceId])

  useEffect(() => {
    useTabsStore
      .getState()
      .setActiveWorkspace(activeWorkspaceId != null ? String(activeWorkspaceId) : null)
  }, [activeWorkspaceId])

  useEffect(() => {
    setWorkspace(activeWorkspaceId, activeInfo?.project.id ?? null)
  }, [activeWorkspaceId, activeInfo, setWorkspace])

  return (
    <div
      className="group/mobile-shell flex w-screen max-w-[100vw] flex-col overflow-hidden bg-background text-foreground"
      data-keyboard-open={keyboardOpen ? "true" : undefined}
      style={{ height: "var(--app-height, 100dvh)" }}
    >
      <Toaster
        position="top-center"
        theme={theme}
        mobileOffset={{
          top: "calc(env(safe-area-inset-top) + 0.75rem)",
          right: "1rem",
          bottom: "calc(env(safe-area-inset-bottom) + 1rem)",
          left: "1rem",
        }}
      />
      {!immersive && (
        <MobileTopBar
          projectName={activeInfo?.project.name ?? null}
          workspaceName={activeInfo?.workspace.name ?? null}
          onTapContext={() => setSwitcherOpen(true)}
          right={<InboxButton onNavigate={handleOpenNotification} />}
        />
      )}

      <main className="min-h-0 flex-1 overflow-hidden">
        {tab === "chats" && (
          <MobileChatsScreen
            keyboardOpen={keyboardOpen}
            openChatId={deepLink?.chatId ?? null}
            openChatTitle={deepLink?.title}
            onDeepLinkConsumed={() => setDeepLink(null)}
            onImmersiveChange={setImmersive}
          />
        )}
        {tab === "channel" && (
          <MobileChannelScreen
            keyboardOpen={keyboardOpen}
            openTaskId={deepLink?.taskId ?? null}
            onDeepLinkConsumed={() => setDeepLink(null)}
          />
        )}
        {tab === "changes" && <MobileReviewScreen worktreePath={activeInfo?.workspace.worktreePath ?? null} />}
        {tab === "more" && <MobileMoreScreen />}
      </main>

      {!keyboardOpen && !immersive && <MobileTabBar active={tab} onChange={setTab} />}

      <MobileContextSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
      <InstallPrompt />
    </div>
  )
}
