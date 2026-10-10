import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { AlertCircle, ArrowLeft, List, Loader2, Settings } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useAssistantStore } from "@/stores/assistant-store"
import { useBackHandler } from "@/hooks/useAndroidBackButton"
import { useNativeShellOverlay } from "@/hooks/useNativeShellOverlay"
import { SettingsPage } from "@/components/settings/SettingsPage"
import { AssistantChat } from "@/components/assistant/AssistantChat"
import { AssistantSidePanel, type SidePanelTab } from "@/components/assistant/AssistantSidePanel"
import { ActivityDetail } from "@/components/assistant/ActivityDrawer"
import { ActivityTab } from "@/components/assistant/ActivityTab"
import { AuditTab } from "@/components/assistant/AuditTab"
import { ProfileTab, PROFILE_FILE_META } from "@/components/assistant/ProfileTab"
import { ProfileFileEditor } from "@/components/assistant/ProfileFileDrawer"
import { ScheduleTab } from "@/components/assistant/ScheduleTab"
import { parseIdentity } from "@/components/assistant/shared"
import type { ProfileFileName } from "@/components/assistant/types"

/** A full-screen page pushed over the thread. Only the top one is shown. */
type Layer =
  | { kind: "panel" }
  | { kind: "activity"; id: string }
  | { kind: "file"; name: ProfileFileName }
  | { kind: "settings" }

function reportError(error: unknown): void {
  toast.error(error instanceof Error ? error.message : String(error))
}

interface MobileAssistantScreenProps {
  keyboardOpen?: boolean
}

/**
 * The personal assistant on a phone. Same store and pieces as the desktop
 * {@link AssistantPage}, rearranged for one column: the thread fills the tab,
 * and what sits in the desktop's right rail (Activity / Audit / Schedule /
 * Profile) and its drawers become pages pushed over it.
 */
export function MobileAssistantScreen({ keyboardOpen = false }: MobileAssistantScreenProps) {
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
  const { send, loadOlder, stopActivity, decide, followUp, saveFile, setScheduleEnabled, deleteSchedule, runSchedule } =
    useAssistantStore.getState()

  const [layers, setLayers] = useState<Layer[]>([])
  // Kept here rather than in the panel so it survives drilling into an activity and back.
  const [panelTab, setPanelTab] = useState<SidePanelTab>("activity")

  useEffect(() => open(), [open])

  const identity = parseIdentity(files.find((f) => f.name === "identity")?.content ?? "")
  const assistantName = identity.name ?? "Assistant"
  const busyCount = activities.filter((a) => a.status === "running" || a.status === "waiting").length

  const top = layers.length > 0 ? layers[layers.length - 1] : null
  const push = (layer: Layer) => setLayers((prev) => [...prev, layer])
  const pop = () => setLayers((prev) => prev.slice(0, -1))

  // Android back / the iOS top bar's back pops one page at a time.
  useBackHandler(top !== null, pop)

  const topActivity = useMemo(
    () => (top?.kind === "activity" ? (activities.find((a) => a.id === top.id) ?? null) : null),
    [top, activities],
  )
  const topFile = top?.kind === "file" ? (files.find((f) => f.name === top.name) ?? null) : null

  return (
    <div className="flex h-full flex-col" style={{ paddingBottom: "var(--keyboard-height, 0px)" }}>
      {/* Three columns so the name sits dead centre: the empty first one is
          as wide as the Activity button and balances it. */}
      <div className="grid h-11 shrink-0 grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center gap-2 border-b border-border/50 px-2">
        <span aria-hidden />
        <button
          type="button"
          onClick={() => {
            setPanelTab("profile")
            push({ kind: "panel" })
          }}
          className="flex min-w-0 max-w-full items-center gap-2.5 justify-self-center text-left"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-muted to-secondary text-[13px] font-semibold text-foreground/80">
            {assistantName.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-base font-semibold leading-tight text-foreground/90">{assistantName}</span>
            <span className="flex items-center gap-1.5 text-[11px] leading-tight text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", busyCount > 0 ? "bg-accent-warm" : "bg-accent-green")} />
              {busyCount > 0 ? `Working on ${busyCount}` : "Idle"}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => {
            setPanelTab("activity")
            push({ kind: "panel" })
          }}
          aria-label={intl.formatMessage({ id: "mobile.assistant.activity", defaultMessage: "Activity" })}
          className="relative flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
        >
          <List className="size-5" />
          {busyCount > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-warm px-1 text-[10px] font-semibold text-white">
              {busyCount}
            </span>
          )}
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {!loaded ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <FormattedMessage id="mobile.assistant.loading" defaultMessage="Loading…" />
          </div>
        ) : loadError && messages.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-2 px-6 text-center text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {loadError}
          </div>
        ) : (
          <div className="flex h-full flex-col">
            {blocker && (
              <div className="shrink-0 px-2 pt-3">
                <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/30 px-3 py-2.5 dark:border-border/35">
                  <AlertCircle className="h-4 w-4 shrink-0 text-status-warn" />
                  <span className="flex-1 text-xs text-muted-foreground">{blocker}</span>
                  <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={() => push({ kind: "settings" })}>
                    <Settings className="h-3.5 w-3.5" />
                    <FormattedMessage id="mobile.more.settings" defaultMessage="Settings" />
                  </Button>
                </div>
              </div>
            )}
            <div className="min-h-0 flex-1">
              <AssistantChat
                compact
                keyboardOpen={keyboardOpen}
                messages={messages}
                typing={typing}
                userName={identity.userName}
                hasMore={hasMore}
                loadingOlder={loadingOlder}
                onLoadOlder={() => void loadOlder().catch(reportError)}
                highlightedActivityId={null}
                onSend={(text, attachments) =>
                  send(text, attachments).catch((error: unknown) => {
                    reportError(error)
                    throw error
                  })
                }
                onOpenActivity={(id) => push({ kind: "activity", id })}
                onDecide={(approvalId, decision) => void decide(approvalId, decision).catch(reportError)}
                onOpenMemory={() => push({ kind: "file", name: "memory" })}
              />
            </div>
          </div>
        )}
      </div>

      {top?.kind === "settings" && (
        <MobileLayer>
          <SettingsPage onBack={pop} initialTab="assistant" />
        </MobileLayer>
      )}

      {top?.kind === "panel" && (
        <MobileLayer title={intl.formatMessage({ id: "mobile.tab.assistant", defaultMessage: "Assistant" })} onBack={pop}>
          <div className="min-h-0 flex-1">
            <AssistantSidePanel
              name={assistantName}
              busyCount={busyCount}
              tab={panelTab}
              onTabChange={setPanelTab}
              onEditIdentity={() => push({ kind: "file", name: "identity" })}
            >
              {panelTab === "activity" && (
                <ActivityTab activities={activities} selectedId={null} onSelect={(id) => push({ kind: "activity", id })} />
              )}
              {panelTab === "audit" && (
                <AuditTab records={audit} />
              )}
              {panelTab === "schedule" && (
                <ScheduleTab
                  schedules={schedules}
                  quietStart={config.quietStart}
                  quietEnd={config.quietEnd}
                  onToggle={(id, enabled) => void setScheduleEnabled(id, enabled).catch(reportError)}
                  onDelete={(id) => void deleteSchedule(id).catch(reportError)}
                  onRun={(id) => {
                    void runSchedule(id)
                      .then(() => toast.success("Running now"))
                      .catch(reportError)
                  }}
                  onEditHeartbeat={() => push({ kind: "file", name: "heartbeat" })}
                  onOpenActivity={(id) => push({ kind: "activity", id })}
                />
              )}
              {panelTab === "profile" && (
                <ProfileTab files={files} assistantName={assistantName} onOpenFile={(name) => push({ kind: "file", name })} />
              )}
            </AssistantSidePanel>
          </div>
        </MobileLayer>
      )}

      {top?.kind === "activity" && (
        <MobileLayer title={intl.formatMessage({ id: "mobile.assistant.activity", defaultMessage: "Activity" })} onBack={pop}>
          {topActivity ? (
            <ActivityDetail
              activity={topActivity}
              layout="stacked"
              onStop={(id) => void stopActivity(id).catch(reportError)}
              onFollowUp={(id, text) => void followUp(id, text).catch(reportError)}
            />
          ) : (
            <LayerMissing />
          )}
        </MobileLayer>
      )}

      {top?.kind === "file" && (
        <MobileLayer title={PROFILE_FILE_META[top.name].title} onBack={pop}>
          {topFile ? (
            <ProfileFileEditor
              compact
              file={topFile}
              assistantName={assistantName}
              onSave={(name, content) =>
                void saveFile(name, content)
                  .then(() => toast.success("Saved"))
                  .catch(reportError)
              }
            />
          ) : (
            <LayerMissing />
          )}
        </MobileLayer>
      )}
    </div>
  )
}

/**
 * A page over the whole app — tab bar included, so a composer at its bottom
 * isn't covered. Without a title it is bare (the child brings its own header,
 * as SettingsPage does).
 */
function MobileLayer({ title, onBack, children }: { title?: string; onBack?: () => void; children: React.ReactNode }) {
  const intl = useIntl()
  // The native tab bar is a real view above the web page; it has to step aside.
  useNativeShellOverlay(true)

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      style={
        title != null
          ? {
              paddingTop: "env(safe-area-inset-top)",
              // With the keyboard up it covers the home-indicator strip, so the two don't stack.
              paddingBottom: "max(env(safe-area-inset-bottom), var(--keyboard-height, 0px))",
            }
          : undefined
      }
    >
      {title != null && (
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/50 px-2">
          <button
            type="button"
            onClick={onBack}
            aria-label={intl.formatMessage({ id: "common.back", defaultMessage: "Back" })}
            className="flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
          >
            <ArrowLeft className="size-5" />
          </button>
          <span className="truncate text-base font-semibold text-foreground/90">{title}</span>
        </div>
      )}
      {children}
    </div>,
    document.body,
  )
}

/** The activity or file went away underneath an open page (cleared, rotated…). */
function LayerMissing() {
  return (
    <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-muted-foreground">
      <FormattedMessage id="mobile.assistant.gone" defaultMessage="This is no longer available." />
    </div>
  )
}
