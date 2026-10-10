import { useEffect, useMemo, useState } from "react"
import { AlertCircle, Loader2, PanelLeft, Settings } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { openSettingsTab } from "@/lib/open-settings"
import { useAssistantStore } from "@/stores/assistant-store"
import { AssistantChat } from "./AssistantChat"
import { AssistantSidePanel, type SidePanelTab } from "./AssistantSidePanel"
import { ActivityDrawer } from "./ActivityDrawer"
import { ActivityTab } from "./ActivityTab"
import { AuditTab } from "./AuditTab"
import { ProfileTab } from "./ProfileTab"
import { ProfileFileDrawer } from "./ProfileFileDrawer"
import { ScheduleTab } from "./ScheduleTab"
import { parseIdentity } from "./shared"
import type { ProfileFileName } from "./types"

interface AssistantPageProps {
  /** With the app sidebar collapsed the header clears the traffic lights and offers to expand it. */
  sidebarCollapsed: boolean
  onExpandSidebar: () => void
}

function reportError(error: unknown): void {
  toast.error(error instanceof Error ? error.message : String(error))
}

/**
 * The personal assistant, shown in place of the editor (center + right) with the
 * app sidebar still on the left: the thread in the middle, what it is doing on the
 * right. State lives on the server (`/api/assistant`) and streams in live.
 */
export function AssistantPage({ sidebarCollapsed, onExpandSidebar }: AssistantPageProps) {
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
  const { send, loadOlder, stopActivity, decide, followUp, saveFile, setScheduleEnabled, deleteSchedule, runSchedule } = useAssistantStore.getState()

  const [tab, setTab] = useState<SidePanelTab>("activity")
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null)
  /** The definition file open in the drawer. Only one drawer shows at a time. */
  const [openFile, setOpenFile] = useState<ProfileFileName | null>(null)

  useEffect(() => open(), [open])

  const identity = parseIdentity(files.find((f) => f.name === "identity")?.content ?? "")
  const assistantName = identity.name ?? "Assistant"
  const busyCount = activities.filter((a) => a.status === "running" || a.status === "waiting").length
  const selectedActivity = useMemo(
    () => activities.find((a) => a.id === selectedActivityId) ?? null,
    [activities, selectedActivityId],
  )

  const openActivity = (id: string) => {
    setOpenFile(null)
    setTab("activity")
    setSelectedActivityId(id)
  }

  const openProfileFile = (file: ProfileFileName) => {
    setSelectedActivityId(null)
    setOpenFile(file)
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div
        className={cn(
          "drag-region flex h-10 shrink-0 items-center gap-2 border-b border-border/50 bg-background pr-4",
          sidebarCollapsed && __APP_TARGET__ !== "web" ? "pl-20" : "pl-4",
        )}
      >
        {sidebarCollapsed && (
          <button
            type="button"
            onClick={onExpandSidebar}
            title="Expand sidebar"
            className="no-drag flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}
        <span className="text-xs text-muted-foreground">Assistant</span>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          {!loaded ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
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
                    <span className="flex-1 text-xs text-muted-foreground">{blocker}</span>
                    <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={() => openSettingsTab("assistant")}>
                      <Settings className="h-3.5 w-3.5" />
                      Settings
                    </Button>
                  </div>
                </div>
              )}
              <div className="min-h-0 flex-1">
                <AssistantChat
                  messages={messages}
                  typing={typing}
                  userName={identity.userName}
                  hasMore={hasMore}
                  loadingOlder={loadingOlder}
                  onLoadOlder={() => void loadOlder().catch(reportError)}
                  highlightedActivityId={selectedActivityId}
                  onSend={(text, attachments) =>
                    send(text, attachments).catch((error: unknown) => {
                      reportError(error)
                      throw error
                    })
                  }
                  onOpenActivity={openActivity}
                  onDecide={(approvalId, decision) => void decide(approvalId, decision).catch(reportError)}
                  onOpenMemory={() => openProfileFile("memory")}
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
          >
            {tab === "activity" && (
              <ActivityTab activities={activities} selectedId={selectedActivityId} onSelect={openActivity} />
            )}
            {tab === "audit" && (
              <AuditTab records={audit} />
            )}
            {tab === "schedule" && (
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
                onEditHeartbeat={() => openProfileFile("heartbeat")}
                onOpenActivity={openActivity}
              />
            )}
            {tab === "profile" && (
              <ProfileTab files={files} assistantName={assistantName} onOpenFile={openProfileFile} />
            )}
          </AssistantSidePanel>
        </aside>

        <ActivityDrawer
          activity={selectedActivity}
          onClose={() => setSelectedActivityId(null)}
          onStop={(id) => void stopActivity(id).catch(reportError)}
          onFollowUp={(id, text) => void followUp(id, text).catch(reportError)}
        />
        <ProfileFileDrawer
          file={files.find((f) => f.name === openFile) ?? null}
          assistantName={assistantName}
          onClose={() => setOpenFile(null)}
          onSave={(name, content) => void saveFile(name, content).catch(reportError)}
        />
      </div>
    </div>
  )
}
