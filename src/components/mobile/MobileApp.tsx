import { contextProjectGroups } from './context-projects'
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Keyboard } from "@capacitor/keyboard"
import { Toaster } from "sonner"
import { useIntl } from "react-intl"
import { hasNativeAssistantBar, hasNativeHeaderBar, hasNativeTabBar, NativeShell, nativePlatform, nativeTopBarTakesSpace, type NativeMenuNode, type NativeTopBarHeader } from "@/lib/native"
import { useNativeShellOverlayCount } from "@/hooks/useNativeShellOverlay"
import { useNativeInboxSheet } from "@/hooks/useNativeInboxSheet"
import { dispatchBack, useAndroidBackButton } from "@/hooks/useAndroidBackButton"
import { useNativeStatusBar } from "@/hooks/useNativeStatusBar"
import { useNativePushNotifications } from "@/hooks/useNativePushNotifications"
import { InboxButton, MobileInboxSheet } from "@/components/inbox/InboxButton"
import { useInboxStore } from "@/stores/inbox-store"
import { useInboxStream } from "@/hooks/useInboxStream"
import type { Notification } from "@/types/notification"
import { useProjectStore } from "@/stores/project-store"
import { useEditorStore } from "@/stores/editor-store"
import { useTabsStore } from "@/stores/tabs-store"
import { useThemeStore, applyTheme } from "@/stores/theme-store"
import { MobileHeaderContext, type MobileHeaderShell, type MobileHeaderSpec, type MobileMenuNode } from "./MobileHeader"
import { MobileTabBar, MOBILE_TABS, MOBILE_TAB_LABELS, isMobileTab, type MobileTab } from "./MobileTabBar"
import { MobileContextSwitcher } from "./MobileContextSwitcher"
import { useProjectFilter } from "@/components/project/ProjectFilterSelect"
import { MobileChatsScreen } from "./MobileChatsScreen"
import { MobileChannelScreen } from "./MobileChannelScreen"
import { MobileReviewScreen } from "./MobileReviewScreen"
import { MobileMoreScreen } from "./MobileMoreScreen"
import { MobileAssistantScreen, type AssistantHeader } from "./MobileAssistantScreen"
import { InstallPrompt } from "@/components/web/InstallPrompt"
import { setAnalyticsScreen } from "@/lib/analytics"

type NotificationTarget = Partial<
  Pick<Notification, "chatId" | "taskId" | "projectId" | "workspaceId" | "title">
> & {
  /** Present on inbox rows and on pushes; the assistant's kinds open its tab. */
  kind?: string
  /** An agent's conversation (tp 'subagent'), e.g. one the assistant dispatched: it keeps its model. */
  subAgent?: boolean
}

/**
 * The tab the app was on, so it comes back there. iOS kills a backgrounded web view when it needs
 * the memory and Capacitor reloads it from scratch: without this, leaving the assistant for a while
 * lands the user back on Chats.
 */
const TAB_STORAGE_KEY = "operon.mobile.tab"

function readSavedTab(): MobileTab {
  try {
    const saved = localStorage.getItem(TAB_STORAGE_KEY)
    return saved && isMobileTab(saved) ? saved : "chats"
  } catch {
    return "chats"
  }
}

/**
 * Phone shell: top context bar + single-column screen + bottom tab bar.
 * Reuses the desktop stores wholesale (project / editor / tabs / theme) and
 * only owns the layout. Mounted by {@link Root} for web on small viewports;
 * the desktop multi-pane app is left completely untouched.
 */
export function MobileApp() {
  const [tab, setTab] = useState<MobileTab>(readSavedTab)
  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, tab)
    } catch {
      // Storage blocked: the app opens on Chats next time, as it always did.
    }
  }, [tab])
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [selectedSpec, setSelectedSpec] = useState<{ id: number; projectId: number } | null>(null)
  // The Board tab spans every project; its header menu narrows it to one
  // instead of switching the workspace. Same filter as the desktop board.
  const [boardFilter, setBoardFilter] = useProjectFilter("operon.boardProjectFilter")
  // Packaged apps only: the inbox sheet opened from the native bell.
  const [nativeInboxOpen, setNativeInboxOpen] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  // A screen can ask for the full viewport (chat transcript): the context bar
  // and tab bar step aside and the screen carries the safe-area insets itself.
  const [immersive, setImmersive] = useState(false)
  // Pending inbox deep-link: switch to the right tab, then the target screen
  // opens the specific chat/task and clears this via onDeepLinkConsumed.
  const [deepLink, setDeepLink] = useState<{ chatId?: number; taskId?: number; title?: string; subAgent?: boolean } | null>(null)

  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeWorkspaceId = useProjectStore((s) => s.activeWorkspaceId)
  const loadProjects = useProjectStore((s) => s.loadProjects)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const setActiveWorkspace = useProjectStore((s) => s.setActiveWorkspace)
  const setWorkspace = useEditorStore((s) => s.setWorkspace)
  const taskNavRequest = useEditorStore((s) => s.taskNavigationRequest)
  const clearTaskNavRequest = useEditorStore((s) => s.clearTaskNavigationRequest)
  const theme = useThemeStore((s) => s.theme)
  const intl = useIntl()

  // Both packaged apps draw the bottom bar natively — a system tab bar on iOS
  // (Liquid Glass on iOS 26), a Material 3 navigation bar on Android — and
  // this shell just mirrors tab state over `NativeShell`. `tabBarHeight` is
  // how much of the bottom the bar covers; the screen pads itself by it while
  // the bar is showing so nothing ends up underneath.
  const nativeTabBar = useMemo(() => hasNativeTabBar(), [])
  const [nativeTabBarHeight, setNativeTabBarHeight] = useState(0)
  // iOS: the assistant's header is the native bar too (real Liquid Glass). The
  // page reports what it shows; the bar floats over the thread, so the page
  // pads by the bar's height itself (44 until the shell reports the real one).
  const nativeAssistantBar = useMemo(() => hasNativeAssistantBar(), [])
  const [assistantHeader, setAssistantHeader] = useState<AssistantHeader | null>(null)
  const [nativeTopBarHeight, setNativeTopBarHeight] = useState(44)
  const overlayCount = useNativeShellOverlayCount()
  const tabBarVisible = !keyboardOpen && !immersive

  useEffect(() => {
    if (!nativeTabBar) return
    let cancelled = false
    // Titles follow the app's locale, so this re-runs when it changes.
    const tabs = MOBILE_TABS.map((id) => ({ id, title: intl.formatMessage(MOBILE_TAB_LABELS[id]) }))
    void NativeShell.configure({ tabs })
      .then(({ tabBarInset }) => {
        if (!cancelled && tabBarInset > 0) setNativeTabBarHeight(tabBarInset)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [nativeTabBar, intl])

  const selectWorkspace = useCallback((projectId: number, workspaceId: number | null) => {
    setSelectedSpec(null)
    setActiveWorkspace(workspaceId, projectId)
  }, [setActiveWorkspace])

  const selectSpec = useCallback((projectId: number, specId: number) => {
    const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
    const workspace = project?.workspaces.find((w) => w.task?.id === specId)
    setActiveWorkspace(workspace?.id ?? null, projectId)
    setSelectedSpec({ id: specId, projectId })
    setDeepLink(null)
    setTab("chats")
  }, [setActiveWorkspace])

  // The picker only selects context; sessions load on the Chats page.
  const openNativeContextSheet = useCallback(async () => {
    const store = useProjectStore.getState()
    try {
      await NativeShell.presentContextSheet({
        title: intl.formatMessage({ id: "mobile.context.title", defaultMessage: "Switch project" }),
        emptyText: intl.formatMessage({ id: "mobile.context.empty", defaultMessage: "No projects yet." }),
        projects: store.projects.map((project) => {
          if (nativePlatform() !== 'ios') return {
            id: project.id, name: project.name,
            workspaces: project.workspaces.map(({ id, name }) => ({ id, name })),
          }
          const groups = contextProjectGroups(project, store.hiddenSpecIds, store.shownSpecIds)
          return {
            id: project.id, name: project.name,
            workspaces: groups.workspaces.map(({ id, name }) => ({ id, name })),
            specs: groups.specs.map((task) => ({ id: task.id, name: task.title })),
          }
        }),
        activeProjectId: selectedSpec?.projectId ?? store.activeProjectId ?? undefined,
        activeWorkspaceId: selectedSpec ? undefined : store.activeWorkspaceId ?? undefined,
        activeSpecId: selectedSpec?.id,
      })
    } catch {
      setSwitcherOpen(true)
    }
  }, [intl, selectedSpec])


  // JS-initiated switches (deep links, Android back, notification taps) show
  // up in the bar too. Harmless after a native tap: selecting the current tab
  // is a no-op.
  useEffect(() => {
    if (!nativeTabBar) return
    void NativeShell.selectTab({ tab }).catch(() => {})
  }, [nativeTabBar, tab])

  // Same rule the web bar follows, plus: step aside for full-screen web
  // overlays (sheets, thread panel), which cannot draw over a native view.
  useEffect(() => {
    if (!nativeTabBar) return
    void NativeShell.setTabBarVisible({ visible: tabBarVisible && overlayCount === 0 }).catch(() => {})
  }, [nativeTabBar, tabBarVisible, overlayCount])

  // The phone's type is the system font, not the desktop stack (globals.css).
  // On <html> rather than this tree's root: the pages pushed over a screen are
  // portalled to <body>.
  useEffect(() => {
    document.documentElement.classList.add("mobile-shell")
    return () => document.documentElement.classList.remove("mobile-shell")
  }, [])

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
    setSelectedSpec(null)
    if (n.kind === "assistant_message" || n.kind === "assistant_approval") {
      setTab("assistant")
    } else if (n.taskId != null) {
      if (n.projectId != null) setActiveProject(n.projectId)
      setTab("channel")
      setDeepLink({ taskId: n.taskId })
    } else if (n.chatId != null) {
      if (n.workspaceId != null) {
        const project = projects.find((p) => p.workspaces.some((w) => w.id === n.workspaceId))
        setActiveWorkspace(n.workspaceId, project?.id ?? null)
      }
      setTab("chats")
      setDeepLink({ chatId: n.chatId, title: n.title, subAgent: n.subAgent })
    }
  }, [projects, setActiveProject, setActiveWorkspace])

  const openContextChat = useCallback((target: { chatId: number; workspaceId?: number; title?: string; subAgent?: boolean }) => {
    const store = useProjectStore.getState()
    const project = target.workspaceId != null
      ? store.projects.find((p) => p.workspaces.some((w) => w.id === target.workspaceId))
      : store.projects.find((p) => p.id === selectedSpec?.projectId)
    const workspaceId = target.workspaceId ?? null
    store.setActiveWorkspace(workspaceId, project?.id)
    // Open in the destination bucket before the screen consumes the deep link.
    setWorkspace(workspaceId, project?.id ?? null)
    setTab("chats")
    setDeepLink({ chatId: target.chatId, title: target.title, subAgent: target.subAgent })
  }, [setWorkspace, selectedSpec?.projectId])

  const openNativeInbox = useNativeInboxSheet(handleOpenNotification)

  useEffect(() => {
    if (!nativeTabBar) return
    const handles = [
      NativeShell.addListener("tabSelected", ({ tab: next }) => {
        if (isMobileTab(next)) setTab(next)
      }),
      NativeShell.addListener("topBarAction", ({ action }) => {
        // A `header` bar's contents act on the page that described them.
        const spec = headerRef.current?.spec
        if (action.startsWith("segment:")) spec?.segments?.onSelect(action.slice("segment:".length))
        else if (action.startsWith("action:")) spec?.actions?.find((a) => a.id === action.slice("action:".length))?.onClick()
        else if (action.startsWith("menu:")) spec?.menu?.onSelect(action.slice("menu:".length))
        else if (action === "context") void openNativeContextSheet()
        else if (action === "inbox") void openNativeInbox().then((ok) => { if (!ok) setNativeInboxOpen(true) })
        // Back closes whatever registered most recently (the open conversation,
        // or a sheet over it) — same stack the Android hardware button uses.
        else if (action === "back") dispatchBack()
      }),
      // Only remember a real height: the bar reports 0 while hidden, and we
      // keep the padding tied to *our* visibility state, not the animation.
      NativeShell.addListener("layout", ({ tabBarInset }) => {
        if (tabBarInset > 0) setNativeTabBarHeight(tabBarInset)
      }),
      NativeShell.addListener("topBarLayout", ({ height }) => {
        if (height > 0) setNativeTopBarHeight(height)
      }),
      // Same rules as MobileContextSwitcher: a workspace activates its project
      // too; a project with no workspaces is activated on its own.
      NativeShell.addListener("contextPicked", ({ projectId, workspaceId, specId, chatId, title }) => {
        if (specId != null) {
          selectSpec(projectId, specId)
        } else if (chatId != null) {
          openContextChat({ chatId, workspaceId, title })
        } else selectWorkspace(projectId, workspaceId ?? null)
      }),
    ]
    return () => {
      for (const handle of handles) void handle.then((h) => h.remove()).catch(() => {})
    }
  }, [nativeTabBar, openNativeContextSheet, openNativeInbox, openContextChat, selectSpec, selectWorkspace])

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

  // List screens draw their own one-row header (MobileHeader: context left,
  // actions + bell right), so the native bar is hidden there. It stays only as
  // the lone back button over an open chat, and as the assistant's capsule.
  const hideTopBar = tab === "assistant"
  // The list screen's header, as its MobileHeader describes it. The spec (with
  // its callbacks) lives in a ref the bar's taps read; the key, which changes
  // only when what the bar shows does, is what redraws the bar.
  const nativeHeader = useMemo(() => hasNativeHeaderBar(), [])
  const headerRef = useRef<{ owner: object; spec: MobileHeaderSpec } | null>(null)
  const [headerKey, setHeaderKey] = useState<string | null>(null)
  const publishHeader = useCallback((owner: object, spec: MobileHeaderSpec) => {
    headerRef.current = { owner, spec }
    setHeaderKey(JSON.stringify({
      segments: spec.segments && { items: spec.segments.items, selected: spec.segments.selected },
      menu: spec.menu && { symbol: spec.menu.symbol, label: spec.menu.label, nodes: spec.menu.nodes },
      actions: spec.actions?.map((a) => [a.id, a.symbol, a.label]) ?? [],
    }))
  }, [])
  const clearHeader = useCallback((owner: object) => {
    if (headerRef.current?.owner !== owner) return
    headerRef.current = null
    setHeaderKey(null)
  }, [])
  const inboxUnread = useInboxStore((s) => s.counts.total > 0)
  const specProject = selectedSpec ? projects.find((p) => p.id === selectedSpec.projectId) : undefined
  const specTitle = selectedSpec
    ? specProject?.specs?.find((s) => s.id === selectedSpec.id)?.title
      ?? specProject?.workspaces.find((w) => w.task?.id === selectedSpec.id)?.task?.title
    : undefined
  const topBarTitle = specProject?.name ?? activeInfo?.project.name ?? "operon"
  const topBarSubtitle = specTitle ?? activeInfo?.workspace.name
  useEffect(() => {
    if (!nativeTabBar) return
    if (tab === "assistant") {
      // Off while one of its pages is pushed: those are web pages over the
      // whole screen, and the bar would float on top of them.
      const header = nativeAssistantBar && assistantHeader && !assistantHeader.covered ? assistantHeader : null
      void NativeShell.setTopBar(
        header
          ? {
              mode: "assistant",
              title: header.title,
              subtitle: header.subtitle,
              busy: header.busy,
              unread: false,
              interactive: overlayCount === 0,
            }
          : { mode: "hidden", title: topBarTitle, unread: false, interactive: true },
      ).catch(() => {})
      return
    }
    const spec = nativeHeader && !immersive && headerKey != null ? headerRef.current?.spec ?? null : null
    let header: NativeTopBarHeader | undefined
    // A list keeps its context/inbox controls while the page header registers
    // after a context switch. Only immersive pages hide the native header.
    if (nativeHeader && !immersive) {
      header = {
        leading: spec?.segments
          ? { kind: "segments", items: spec.segments.items.map((i) => ({ id: i.id, title: i.label })), selected: spec.segments.selected }
          : { kind: "context", title: topBarTitle, subtitle: topBarSubtitle },
        // A system pull-down, picked in place.
        menu: spec?.menu && { symbol: spec.menu.symbol, label: spec.menu.label, nodes: toNativeMenu(spec.menu.nodes) },
        actions: spec?.actions?.map((a) => ({ id: a.id, symbol: a.symbol, label: a.label })) ?? [],
      }
    }
    void NativeShell.setTopBar({
      mode: immersive && tab === "chats" ? "back" : header ? "header" : "hidden",
      title: topBarTitle,
      subtitle: topBarSubtitle,
      unread: inboxUnread,
      interactive: overlayCount === 0,
      header,
    }).catch(() => {})
  }, [nativeTabBar, nativeAssistantBar, nativeHeader, tab, assistantHeader, hideTopBar, immersive, topBarTitle, topBarSubtitle, inboxUnread, overlayCount, headerKey])

  // On iOS the top safe-area inset already includes the native navigation
  // bar, so list screens just pad by it; immersive screens carry their own
  // inset (see MobileChatsScreen). Android needs none of this: its shell
  // moves the web view below the bars instead of drawing over it, so the
  // space is already gone, and padding again would double it. Without the
  // web top bar (the assistant) the page takes the status-bar inset itself.
  const topInset =
    (nativeTabBar && !immersive && !nativeTopBarTakesSpace()) || (!nativeTabBar && hideTopBar)
      ? "env(safe-area-inset-top)"
      : "0px"
  // With no bar above it, a page's own top clears the status bar — except on
  // Android, whose shell already keeps the web view below it (and below its
  // header bar while that is up).
  const headerInset = nativeTabBar && nativeTopBarTakesSpace() ? "0px" : "env(safe-area-inset-top)"

  // iOS 26's tab bar is a glass capsule over the page: lists scroll under it.
  // Android's is an opaque bar, and the page simply stops above it.
  const tabBarFloats = nativeTabBar && !nativeTopBarTakesSpace() && tabBarVisible

  const openInboxSheet = useCallback(() => {
    void openNativeInbox().then((ok) => {
      if (!ok) setNativeInboxOpen(true)
    })
  }, [openNativeInbox])
  const headerShell: MobileHeaderShell = {
    topInset: headerInset,
    projectName: specProject?.name ?? activeInfo?.project.name ?? null,
    workspaceName: specTitle ?? activeInfo?.workspace.name ?? null,
    openContext: () => (nativeTabBar ? void openNativeContextSheet() : setSwitcherOpen(true)),
    bell: (
      <InboxButton
        onNavigate={handleOpenNotification}
        onOpenSheet={nativeTabBar ? openInboxSheet : undefined}
        className="size-9 rounded-lg"
      />
    ),
    native: nativeHeader,
    barHeight: nativeTopBarHeight,
    tabBarOverlay: tabBarFloats ? nativeTabBarHeight : 0,
    publishHeader,
    clearHeader,
  }

  useEffect(() => {
    useTabsStore
      .getState()
      .setActiveWorkspace(activeWorkspaceId != null ? String(activeWorkspaceId) : null)
  }, [activeWorkspaceId])

  useEffect(() => {
    setWorkspace(activeWorkspaceId, activeProjectId)
  }, [activeWorkspaceId, activeProjectId, setWorkspace])

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
      {/* Every screen draws its own top: list screens a MobileHeader, an open
          conversation its own row, the assistant a header floating over its
          thread (handed the inset rather than pushed down). */}
      <MobileHeaderContext.Provider value={headerShell}>
      <main
        className="min-h-0 flex-1 overflow-hidden"
        style={{
          // Where the tab bar floats the list screens pad their own last row
          // (useMobileContentBottom); the assistant keeps its composer above it.
          paddingBottom: nativeTabBar && tabBarVisible && (!tabBarFloats || tab === "assistant") ? `${nativeTabBarHeight}px` : undefined,
        }}
      >
        {tab === "chats" && (
          <MobileChatsScreen
            key={selectedSpec ? `spec:${selectedSpec.id}` : `workspace:${activeWorkspaceId}`}
            specId={selectedSpec?.id}
            onOpenSpecChat={openContextChat}
            keyboardOpen={keyboardOpen}
            openChatId={deepLink?.chatId ?? null}
            openChatTitle={deepLink?.title}
            openChatSubAgent={deepLink?.subAgent}
            onDeepLinkConsumed={() => setDeepLink(null)}
            onImmersiveChange={setImmersive}
          />
        )}
        {tab === "assistant" && <MobileAssistantScreen
            keyboardOpen={keyboardOpen}
            topInset={topInset}
            nativeBarHeight={nativeAssistantBar ? nativeTopBarHeight : null}
            onHeaderChange={setAssistantHeader}
            onOpenChat={(target) => handleOpenNotification(target)}
          />}
        {tab === "channel" && (
          <MobileChannelScreen
            keyboardOpen={keyboardOpen}
            projectFilter={boardFilter}
            onProjectFilterChange={setBoardFilter}
            onImmersiveChange={setImmersive}
            openTaskId={deepLink?.taskId ?? null}
            onDeepLinkConsumed={() => setDeepLink(null)}
            onOpenChat={(chat) =>
              handleOpenNotification({
                chatId: chat.chatId,
                workspaceId: chat.workspaceId,
                title: chat.title,
                subAgent: chat.subAgent || undefined,
              })
            }
          />
        )}
        {tab === "changes" && <MobileReviewScreen worktreePath={activeInfo?.workspace.worktreePath ?? null} />}
        {tab === "more" && <MobileMoreScreen />}
      </main>
      </MobileHeaderContext.Provider>

      {!nativeTabBar && tabBarVisible && <MobileTabBar active={tab} onChange={setTab} />}

      <MobileContextSwitcher
        selectedSpecId={selectedSpec?.id ?? null}
        onSelectSpec={selectSpec}
        onSelectWorkspace={selectWorkspace}
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
      />
      {nativeTabBar && (
        <MobileInboxSheet
          open={nativeInboxOpen}
          onClose={() => setNativeInboxOpen(false)}
          onNavigate={handleOpenNotification}
        />
      )}
      <InstallPrompt />
    </div>
  )
}

function toNativeMenu(nodes: MobileMenuNode[]): NativeMenuNode[] {
  return nodes.map((node) =>
    node.kind === "item"
      ? { kind: "item", id: node.id, title: node.label, selected: node.selected }
      : { kind: "group", id: node.id, title: node.label, inline: node.inline ?? false, detail: node.detail, children: toNativeMenu(node.children) },
  )
}
