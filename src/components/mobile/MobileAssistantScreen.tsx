import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { createPortal } from "react-dom"
import { AlertCircle, ArrowLeft, Loader2, Settings } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useAssistantStore } from "@/stores/assistant-store"
import { useBackHandler } from "@/hooks/useAndroidBackButton"
import { useNativeShellOverlay } from "@/hooks/useNativeShellOverlay"
import { NativeShell } from "@/lib/native"
import { SettingsPage } from "@/components/settings/SettingsPage"
import { AssistantChat } from "@/components/assistant/AssistantChat"
import { AssistantSidePanel, type SidePanelTab } from "@/components/assistant/AssistantSidePanel"
import { ActivityDetail } from "@/components/assistant/ActivityDrawer"
import { ActivityTab } from "@/components/assistant/ActivityTab"
import { AssistantFileView, assistantFile, useAssistantFileOpener, type OpenAssistantFile } from "@/components/assistant/AssistantFileDrawer"
import { FilesTab } from "@/components/assistant/FilesTab"
import { FileOpenProvider } from "@/lib/file-open-context"
import { basename } from "@/lib/workspace-files"
import { AuditTab } from "@/components/assistant/AuditTab"
import { ProfileTab, PROFILE_FILE_META } from "@/components/assistant/ProfileTab"
import { ProfileFileEditor } from "@/components/assistant/ProfileFileDrawer"
import { ScheduleTab } from "@/components/assistant/ScheduleTab"
import { DetentSheet } from "./DetentSheet"
import { parseIdentity } from "@/components/assistant/shared"
import { blockerText, busyLabel } from "@/components/assistant/assistant-i18n"
import type { Activity, ProfileFileName } from "@/components/assistant/types"
import { chatTargetOf, type ChatTarget } from "@/components/assistant/AssistantPage"

/** A page pushed over the thread (an activity: a sheet). Only the top one is shown. */
type Layer =
  | { kind: "panel" }
  | { kind: "activity"; id: string }
  | { kind: "file"; name: ProfileFileName }
  | { kind: "workspaceFile"; file: OpenAssistantFile }
  | { kind: "settings" }

/** What the header shows, for the shell to mirror in the native bar (iOS). */
export interface AssistantHeader {
  title: string
  subtitle: string
  busy: boolean
  /** A page is pushed over the thread; the bar must get out of its way. */
  covered: boolean
}

function reportError(error: unknown): void {
  toast.error(error instanceof Error ? error.message : String(error))
}

interface MobileAssistantScreenProps {
  keyboardOpen?: boolean
  /** How much of the top the status bar covers; the header sits below it. */
  topInset?: string
  /**
   * The header is the native bar (iOS) and this is its height. It floats over
   * the thread like the web one would, so the page only leaves room for it.
   * `null`: no native bar for this — the page draws the header itself.
   */
  nativeBarHeight?: number | null
  onHeaderChange?: (header: AssistantHeader | null) => void
  /** Open a coding agent's conversation (the Chats tab, in its workspace). */
  onOpenChat: (target: ChatTarget) => void
}

/**
 * The personal assistant on a phone. Same store and pieces as the desktop
 * {@link AssistantPage}, rearranged for one column: the thread fills the tab,
 * and what sits in the desktop's right rail (Activity / Audit / Schedule /
 * Profile) and its drawers become pages pushed over it.
 */
export function MobileAssistantScreen({
  keyboardOpen = false,
  topInset = "0px",
  nativeBarHeight = null,
  onHeaderChange,
  onOpenChat,
}: MobileAssistantScreenProps) {
  const intl = useIntl()
  const open = useAssistantStore((s) => s.open)
  const loaded = useAssistantStore((s) => s.loaded)
  const loadError = useAssistantStore((s) => s.error)
  const messages = useAssistantStore((s) => s.messages)
  const hasMore = useAssistantStore((s) => s.hasMore)
  const loadingOlder = useAssistantStore((s) => s.loadingOlder)
  const activities = useAssistantStore((s) => s.activities)
  const audit = useAssistantStore((s) => s.audit)
  const files = useAssistantStore((s) => s.files)
  const schedules = useAssistantStore((s) => s.schedules)
  const config = useAssistantStore((s) => s.config)
  const typing = useAssistantStore((s) => s.typing)
  const blocker = useAssistantStore((s) => s.blocker)
  const blockerReason = useAssistantStore((s) => s.blockerReason)
  const { send, loadOlder, settleAtBottom, stopActivity, decide, followUp, saveFile, setScheduleEnabled, deleteSchedule, runSchedule } =
    useAssistantStore.getState()

  // Each pushed page keeps an id of its own, so it slides out as itself when
  // popped even if an identical one is pushed again right after.
  const [layers, setLayers] = useState<{ id: number; layer: Layer }[]>([])
  const nextLayerId = useRef(0)
  // Kept here rather than in the panel so it survives drilling into an activity and back.
  const [panelTab, setPanelTab] = useState<SidePanelTab>("activity")

  useEffect(() => open(), [open])

  const identity = parseIdentity(files.find((f) => f.name === "identity")?.content ?? "")
  const assistantName = identity.name ?? intl.formatMessage({ id: "assistant.defaultName", defaultMessage: "Assistant" })
  const busyCount = activities.filter((a) => a.status === "running" || a.status === "waiting").length
  const status = busyLabel(intl, busyCount > 0)

  const push = useCallback((layer: Layer) => {
    const id = nextLayerId.current++
    setLayers((prev) => [...prev, { id, layer }])
  }, [])
  const pop = () => setLayers((prev) => prev.slice(0, -1))
  // Stable, so the thread's memoized bubbles don't all re-render on every event.
  const onDecide = useCallback(
    (approvalId: string, decision: "allowed_once" | "denied") => void decide(approvalId, decision).catch(reportError),
    [decide],
  )
  const openMemory = useCallback(() => push({ kind: "file", name: "memory" }), [push])
  // File references in its replies are its own, not the active workspace's.
  const openFileRef = useAssistantFileOpener(useCallback((file: OpenAssistantFile) => push({ kind: "workspaceFile", file }), [push]))
  const filesRefreshKey = `${messages.length}|${typing}|${activities.map((a) => a.status).join(",")}`
  const openCoding = useCallback(
    (activity: Activity) => {
      const target = chatTargetOf(activity)
      if (target) onOpenChat(target)
    },
    [onOpenChat],
  )
  const openPanel = useCallback(
    (tab: SidePanelTab) => {
      setPanelTab(tab)
      push({ kind: "panel" })
    },
    [push],
  )

  // Android back / the iOS top bar's back pops one page at a time.
  useBackHandler(layers.length > 0, pop)

  const native = nativeBarHeight != null
  const covered = layers.length > 0
  // Nothing until the first load lands: the name comes with it (identity.md), and showing the
  // default "Assistant" first read as the name changing a moment later.
  useEffect(() => {
    onHeaderChange?.(
      loaded
        ? {
            title: assistantName,
            subtitle: status,
            busy: busyCount > 0,
            covered,
          }
        : null,
    )
  }, [onHeaderChange, loaded, assistantName, status, busyCount, covered])
  useEffect(() => () => onHeaderChange?.(null), [onHeaderChange])

  // The native bar's taps.
  useEffect(() => {
    if (!native) return
    const handle = NativeShell.addListener("topBarAction", ({ action }) => {
      if (action === "assistantProfile") openPanel("activity")
    })
    return () => void handle.then((h) => h.remove()).catch(() => {})
  }, [native, openPanel])

  // The floating header's height, so the thread starts below it. Measured, not
  // fixed: the safe-area inset and the setup notice both change it.
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = useState(0)
  useLayoutEffect(() => {
    const el = headerRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setHeaderHeight(el.offsetHeight))
    observer.observe(el)
    setHeaderHeight(el.offsetHeight)
    return () => observer.disconnect()
  }, [])

  const renderLayer = (layer: Layer) => {
    switch (layer.kind) {
      case "settings":
        return <SettingsPage onBack={pop} initialTab="assistant" />
      case "panel":
        return (
          <div className="min-h-0 flex-1">
            <AssistantSidePanel
              large
              name={assistantName}
              busyCount={busyCount}
              tab={panelTab}
              onTabChange={setPanelTab}
              onEditIdentity={() => push({ kind: "file", name: "identity" })}
              onClose={pop}
            >
              {panelTab === "activity" && (
                <ActivityTab
                  large
                  activities={activities}
                  selectedId={null}
                  onSelect={(id) => push({ kind: "activity", id })}
                />
              )}
              {panelTab === "files" && (
                <FilesTab
                  large
                  selectedPath={null}
                  onOpen={(path, root) => push({ kind: "workspaceFile", file: assistantFile(path, { resolved: { path, root } }) })}
                  refreshKey={filesRefreshKey}
                />
              )}
              {panelTab === "audit" && <AuditTab records={audit} />}
              {panelTab === "schedule" && (
                <ScheduleTab
                  schedules={schedules}
                  quietStart={config.quietStart}
                  quietEnd={config.quietEnd}
                  onToggle={(id, enabled) => void setScheduleEnabled(id, enabled).catch(reportError)}
                  onDelete={(id) => void deleteSchedule(id).catch(reportError)}
                  onRun={(id) => {
                    void runSchedule(id)
                      .then(() => toast.success(intl.formatMessage({ id: "assistant.schedule.runningNow", defaultMessage: "Running now" })))
                      .catch(reportError)
                  }}
                  checklist={files.find((f) => f.name === "heartbeat")?.content ?? ""}
                  onOpenChecklist={() => push({ kind: "file", name: "heartbeat" })}
                  onOpenActivity={(id) => push({ kind: "activity", id })}
                />
              )}
              {panelTab === "profile" && (
                <ProfileTab
                  files={files}
                  assistantName={assistantName}
                  onOpenFile={(name) => push({ kind: "file", name })}
                />
              )}
            </AssistantSidePanel>
          </div>
        )
      case "activity": {
        const activity = activities.find((a) => a.id === layer.id)
        return activity ? (
          <ActivityDetail
            activity={activity}
            layout="stacked"
            onClose={pop}
            onStop={(id) => void stopActivity(id).catch(reportError)}
            onFollowUp={(id, text) => void followUp(id, text).catch(reportError)}
            onOpenCoding={openCoding}
          />
        ) : (
          <LayerMissing />
        )
      }
      case "workspaceFile":
        return <AssistantFileView file={layer.file} />
      case "file": {
        const file = files.find((f) => f.name === layer.name)
        return file ? (
          <ProfileFileEditor
            compact
            file={file}
            assistantName={assistantName}
            onSave={(name, content) =>
              void saveFile(name, content)
                .then(() => toast.success(intl.formatMessage({ id: "assistant.profile.saved", defaultMessage: "Saved" })))
                .catch(reportError)
            }
          />
        ) : (
          <LayerMissing />
        )
      }
    }
  }

  const layerVariant = (layer: Layer): "page" | "bare" | "sheet" =>
    layer.kind === "activity" ? "sheet" : layer.kind === "file" || layer.kind === "workspaceFile" ? "page" : "bare"
  const layerTitle = (layer: Layer): string | undefined =>
    layer.kind === "file"
      ? intl.formatMessage(PROFILE_FILE_META[layer.name].title)
      : layer.kind === "workspaceFile"
        ? basename(layer.file.path)
        : undefined

  return (
    <FileOpenProvider value={openFileRef}>
      <div className="relative flex h-full flex-col" style={{ paddingBottom: "var(--keyboard-height, 0px)" }}>
        <div className="min-h-0 flex-1">
          {!loaded ? (
            <div
              className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
              style={{ paddingTop: headerHeight }}
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              <FormattedMessage id="mobile.assistant.loading" defaultMessage="Loading…" />
            </div>
          ) : loadError && messages.length === 0 ? (
            <div
              className="flex h-full items-center justify-center gap-2 px-6 text-center text-xs text-destructive"
              style={{ paddingTop: headerHeight }}
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {loadError}
            </div>
          ) : (
            <AssistantChat
              compact
              keyboardOpen={keyboardOpen}
              insetTop={headerHeight}
              messages={messages}
              typing={typing}
              assistantName={identity.name}
              hasMore={hasMore}
              loadingOlder={loadingOlder}
              onLoadOlder={() => void loadOlder().catch(reportError)}
              onSend={(text, attachments) =>
                send(text, attachments).catch((error: unknown) => {
                  reportError(error)
                  throw error
                })
              }
              onDecide={onDecide}
              onOpenMemory={openMemory}
              activities={activities}
              onOpenChat={openCoding}
              onAtBottom={settleAtBottom}
            />
          )}
        </div>

        {/* The header floats over the thread, which scrolls up under it and the
            status bar — more of the conversation fits, and the glass shows it
            frosted. On iOS the header itself is the native bar (real Liquid
            Glass) and this only holds its place; elsewhere the page draws it.
            Only the controls take touches; the gaps let a drag through. */}
        <div
          ref={headerRef}
          className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col gap-2 px-3 pb-2"
          style={{
            paddingTop: `calc(${topInset} + ${native ? nativeBarHeight : 0}px + 0.5rem)`,
          }}
        >
          {/* Keeps the status bar and the header legible over what scrolls behind. */}
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 bg-gradient-to-b from-background via-background/70 to-transparent"
            style={{
              height: `calc(${topInset} + ${native ? nativeBarHeight : 24}px)`,
            }}
          />
          {!native && (
            /* The capsule is the only way into the assistant's page, which opens
               on its Activity list. */
            <div className="relative flex justify-center">
              <button
                type="button"
                onClick={() => openPanel("activity")}
                aria-label={`${assistantName}, ${status}`}
                // Held invisible (not removed) until the first load, so it comes in with the real
                // name and the thread below doesn't shift when it does.
                className={cn(
                  "liquid-glass pointer-events-auto flex h-11 min-w-0 max-w-full items-center gap-2.5 rounded-full py-1.5 pl-1.5 pr-4 text-left transition-transform active:scale-[0.97]",
                  loaded ? "animate-in fade-in-0 duration-200" : "invisible",
                )}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-muted to-secondary text-[13px] font-semibold text-foreground/80">
                  {assistantName.slice(0, 1).toUpperCase()}
                </span>
                {/* Idle is the usual state and says nothing worth a label: the name then.
                    Only while it works does the capsule show a status. */}
                {busyCount > 0 ? (
                  <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-muted-foreground">
                    <span className="size-2 shrink-0 rounded-full bg-accent-warm" />
                    <span className="truncate">{status}</span>
                  </span>
                ) : (
                  <span className="truncate text-sm font-semibold text-foreground/85">{assistantName}</span>
                )}
              </button>
            </div>
          )}
          {loaded && blocker && (
            <div className="liquid-glass pointer-events-auto relative flex items-center gap-3 rounded-xl px-3 py-2.5">
              <AlertCircle className="h-4 w-4 shrink-0 text-status-warn" />
              <span className="flex-1 text-xs text-muted-foreground">{blockerText(intl, blocker, blockerReason)}</span>
              <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={() => push({ kind: "settings" })}>
                <Settings className="h-3.5 w-3.5" />
                <FormattedMessage id="mobile.more.settings" defaultMessage="Settings" />
              </Button>
            </div>
          )}
        </div>

        {/* Every pushed page stays mounted under the one above it, so popping
            slides the top one away and uncovers the last, as a navigation stack does. */}
        <AnimatePresence>
          {layers.map(({ id, layer }) => (
            <MobileLayer key={id} variant={layerVariant(layer)} title={layerTitle(layer)} onBack={pop}>
              {renderLayer(layer)}
            </MobileLayer>
          ))}
        </AnimatePresence>
      </div>
    </FileOpenProvider>
  )
}

/**
 * A page over the whole app — tab bar included, so a composer at its bottom
 * isn't covered. `page` slides in from the right with a back bar of its own
 * (`title`); `bare` slides in the same way but brings its own header (as
 * SettingsPage and the assistant's page do); `sheet` rises from the bottom as a
 * card (DetentSheet) that swipes open, back to rest or away; a tap on the
 * dimmed rest closes it.
 */
function MobileLayer({
  variant,
  title,
  onBack,
  children,
}: {
  variant: "page" | "bare" | "sheet"
  title?: string
  onBack: () => void
  children: React.ReactNode
}) {
  const intl = useIntl()
  // The native tab bar is a real view above the web page; it has to step aside.
  useNativeShellOverlay(true)

  if (variant === "sheet") {
    return createPortal(
      <>
        <motion.div
          aria-hidden
          className="fixed inset-0 z-50 bg-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={LAYER_TRANSITION}
          onClick={onBack}
        />
        <DetentSheet onClose={onBack}>{children}</DetentSheet>
      </>,
      document.body,
    )
  }

  return createPortal(
    <>
      {/* The page underneath dims as this one comes over it. */}
      <motion.div
        aria-hidden
        className="fixed inset-0 z-50 bg-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.5 }}
        exit={{ opacity: 0 }}
        transition={LAYER_TRANSITION}
      />
      <motion.div
        className="fixed inset-0 z-50 flex flex-col bg-background shadow-drawer"
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={LAYER_TRANSITION}
        style={
          variant === "page"
            ? {
                paddingTop: "env(safe-area-inset-top)",
                // With the keyboard up it covers the home-indicator strip, so the two don't stack.
                paddingBottom: "max(env(safe-area-inset-bottom), var(--keyboard-height, 0px))",
              }
            : undefined
        }
      >
        {variant === "page" && (
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/50 px-2">
            <button
              type="button"
              onClick={onBack}
              aria-label={intl.formatMessage({
                id: "common.back",
                defaultMessage: "Back",
              })}
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
            >
              <ArrowLeft className="size-5" />
            </button>
            <span className="truncate text-base font-semibold text-foreground/90">{title}</span>
          </div>
        )}
        {children}
      </motion.div>
    </>,
    document.body,
  )
}

/** Close to UIKit's push: quick off the mark, long settle. */
const LAYER_TRANSITION = {
  type: "tween",
  duration: 0.38,
  ease: [0.32, 0.72, 0, 1],
} as const

/** The activity or file went away underneath an open page (cleared, rotated…). */
function LayerMissing() {
  return (
    <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-muted-foreground">
      <FormattedMessage id="mobile.assistant.gone" defaultMessage="This is no longer available." />
    </div>
  )
}
