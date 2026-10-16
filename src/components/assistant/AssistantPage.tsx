import { useCallback, useEffect, useState } from "react"
import { AlertCircle, Loader2, PanelLeft, Settings } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { AccountUsageBar } from "@/components/app-shell/AccountUsageBar"
import { FileOpenProvider } from "@/lib/file-open-context"
import { openPluginsPage, openSettingsTab } from "@/lib/open-settings"
import { useAssistantStore } from "@/stores/assistant-store"
import { AssistantChat } from "./AssistantChat"
import { AssistantSidePanel, PanelTabLoading, usePanelTabReady, type SidePanelTab } from "./AssistantSidePanel"
import { ActivityDrawer } from "./ActivityDrawer"
import { ActivityTab } from "./ActivityTab"
import { AssistantFileDrawer, assistantFile, useAssistantFileOpener, type OpenAssistantFile } from "./AssistantFileDrawer"
import { FilesTab, RevealFolderButton } from "./FilesTab"
import { AuditTab } from "./AuditTab"
import { ProfileTab } from "./ProfileTab"
import { ProfileFileDrawer } from "./ProfileFileDrawer"
import { ScheduleTab } from "./ScheduleTab"
import { parseIdentity } from "./shared"
import { blockerText } from "./assistant-i18n"
import type { ActivitySummary, ProfileFileName } from "./types"

/** A conversation in one of the user's workspaces, to open in its tab. */
export interface ChatTarget {
  chatId: number
  workspaceId: number
  title: string
  /** An agent's conversation (tp 'subagent'): it keeps the model it was started with. */
  subAgent: boolean
}

/** Where a coding agent's activity leads: its conversation. */
export function chatTargetOf(activity: ActivitySummary): ChatTarget | undefined {
  const c = activity.coding
  return c ? { chatId: c.chatId, workspaceId: c.workspaceId, title: activity.title, subAgent: true } : undefined
}

interface AssistantPageProps {
  /** With the app sidebar collapsed the header clears the traffic lights and offers to expand it. */
  sidebarCollapsed: boolean
  onExpandSidebar: () => void
  onOpenChat: (target: ChatTarget) => void
}

function reportError(error: unknown): void {
  toast.error(error instanceof Error ? error.message : String(error))
}

/**
 * The personal assistant, shown in place of the editor (center + right) with the
 * app sidebar still on the left: the thread in the middle, what it is doing on the
 * right. State lives on the server (`/api/assistant`) and streams in live.
 */
export function AssistantPage({ sidebarCollapsed, onExpandSidebar, onOpenChat }: AssistantPageProps) {
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
  const { send, loadOlder, settleAtBottom, stopActivity, decide, followUp, saveFile, setScheduleEnabled, deleteSchedule, runSchedule } = useAssistantStore.getState()

  const intl = useIntl()
  const [tab, setTab] = useState<SidePanelTab>("activity")
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null)
  /** The definition file open in the drawer. Only one drawer shows at a time. */
  const [openFile, setOpenFile] = useState<ProfileFileName | null>(null)
  /** A file it wrote, open in the preview drawer. */
  const [openedFile, setOpenedFile] = useState<OpenAssistantFile | null>(null)
  /** The assistant's workspace folder, learned from the Files listing. */
  const [filesDir, setFilesDir] = useState<string | null>(null)

  useEffect(() => open(), [open])

  const identity = parseIdentity(files.find((f) => f.name === "identity")?.content ?? "")
  const assistantName = identity.name ?? intl.formatMessage({ id: "assistant.defaultName", defaultMessage: "Assistant" })
  const busyCount = activities.filter((a) => a.status === "running" || a.status === "waiting").length
  const tabReady = usePanelTabReady(tab)

  const openActivity = (id: string) => {
    setOpenFile(null)
    setOpenedFile(null)
    setTab("activity")
    setSelectedActivityId(id)
  }

  const openProfileFile = useCallback((file: ProfileFileName) => {
    setSelectedActivityId(null)
    setOpenedFile(null)
    setOpenFile(file)
  }, [])
  const showFile = useCallback((file: OpenAssistantFile) => {
    setSelectedActivityId(null)
    setOpenFile(null)
    setOpenedFile(file)
  }, [])
  // File references in its replies (and links inside the files) are its own, not the active workspace's.
  const openFileRef = useAssistantFileOpener(showFile)
  // Whatever it writes lands while it replies or a worker runs: list again when either moves.
  const filesRefreshKey = `${messages.length}|${typing}|${activities.map((a) => a.status).join(",")}`
  // Stable, so the thread's memoized bubbles don't all re-render on every event.
  const openMemory = useCallback(() => openProfileFile("memory"), [openProfileFile])
  const onDecide = useCallback(
    (approvalId: string, decision: "allowed_once" | "denied") => void decide(approvalId, decision).catch(reportError),
    [decide],
  )
  const openCoding = useCallback(
    (activity: ActivitySummary) => {
      const target = chatTargetOf(activity)
      if (target) onOpenChat(target)
    },
    [onOpenChat],
  )

  return (
    <div className="flex h-full flex-col bg-background">
      <div
        className={cn(
          // @container/topbar: the usage bar thins out by this row's width, as in the workspace top bar.
          "@container/topbar drag-region flex h-10 shrink-0 items-center gap-2 border-b border-border/50 bg-background pr-4",
          sidebarCollapsed && __APP_TARGET__ !== "web" ? "pl-20" : "pl-4",
        )}
      >
        {sidebarCollapsed && (
          <button
            type="button"
            onClick={onExpandSidebar}
            title={intl.formatMessage({ id: "assistant.expandSidebar", defaultMessage: "Expand sidebar" })}
            className="no-drag flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          <FormattedMessage id="mobile.tab.assistant" defaultMessage="Assistant" />
        </span>
        {/* Account quota, same as the workspace top bar: it is the app's, not a workspace's.
            A real child of this drag row so its `no-drag` holds. */}
        <AccountUsageBar className="shrink-0" />
      </div>

      <FileOpenProvider value={openFileRef}>
        <div className="relative flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
            {!loaded ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> <FormattedMessage id="mobile.assistant.loading" defaultMessage="Loading…" />
              </div>
            ) : loadError && messages.length === 0 ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5" /> {loadError}
              </div>
            ) : (
              <>
                {blocker && (
                  <div className="mx-auto mt-4 w-full max-w-3xl px-6">
                    <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/30 px-4 py-3 dark:border-border/35">
                      <AlertCircle className="h-4 w-4 shrink-0 text-status-warn" />
                      <span className="flex-1 text-xs text-muted-foreground">{blockerText(intl, blocker, blockerReason)}</span>
                      <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={() => openSettingsTab("assistant")}>
                        <Settings className="h-3.5 w-3.5" />
                        <FormattedMessage id="mobile.more.settings" defaultMessage="Settings" />
                      </Button>
                    </div>
                  </div>
                )}
                <div className="min-h-0 flex-1">
                  <AssistantChat
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
                </div>
              </>
            )}
          </main>

          <aside className="w-[340px] shrink-0 border-l border-border/50 bg-sidebar">
            <AssistantSidePanel
              name={assistantName}
              busyCount={busyCount}
              tab={tab}
              onTabChange={setTab}
              onEditIdentity={() => openProfileFile("identity")}
              headerAction={tab === "files" && filesDir ? <RevealFolderButton dir={filesDir} /> : undefined}
            >
              {!tabReady && <PanelTabLoading />}
              {tab === "activity" && tabReady && (
                <ActivityTab activities={activities} selectedId={selectedActivityId} onSelect={openActivity} />
              )}
              {tab === "files" && (
                <FilesTab
                  selectedPath={openedFile?.resolved?.path ?? null}
                  onOpen={(path, root) => showFile(assistantFile(path, { resolved: { path, root } }))}
                  refreshKey={filesRefreshKey}
                  onDir={setFilesDir}
                />
              )}
              {tab === "audit" && tabReady && (
                <AuditTab records={audit} />
              )}
              {tab === "schedule" && tabReady && (
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
                  onOpenActivity={openActivity}
                  onConnectPlugin={openPluginsPage}
                  checklist={files.find((f) => f.name === "heartbeat")?.content ?? ""}
                  onOpenChecklist={() => openProfileFile("heartbeat")}
                />
              )}
              {tab === "profile" && (
                <ProfileTab files={files} assistantName={assistantName} onOpenFile={openProfileFile} />
              )}
            </AssistantSidePanel>
          </aside>

          <ActivityDrawer
            activityId={selectedActivityId}
            onClose={() => setSelectedActivityId(null)}
            onStop={(id) => void stopActivity(id).catch(reportError)}
            onFollowUp={(id, text) => void followUp(id, text).catch(reportError)}
            onOpenCoding={openCoding}
          />
          <ProfileFileDrawer
            file={files.find((f) => f.name === openFile) ?? null}
            assistantName={assistantName}
            onClose={() => setOpenFile(null)}
            onSave={(name, content) => void saveFile(name, content).catch(reportError)}
          />
          <AssistantFileDrawer file={openedFile} onClose={() => setOpenedFile(null)} />
        </div>
      </FileOpenProvider>
    </div>
  )
}
