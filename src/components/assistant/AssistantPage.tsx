import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { PanelLeft } from "lucide-react"
import { cn } from "@/lib/utils"
import { AssistantChat } from "./AssistantChat"
import { AssistantSidePanel, type SidePanelTab } from "./AssistantSidePanel"
import { ActivityDrawer } from "./ActivityDrawer"
import { ActivityTab } from "./ActivityTab"
import { AuditTab } from "./AuditTab"
import { ScheduleTab } from "./ScheduleTab"
import { ProfileTab } from "./ProfileTab"
import { ProfileFileDrawer } from "./ProfileFileDrawer"
import { parseIdentity } from "./shared"
import { MOCK_ACTIVITIES, MOCK_AUDIT, MOCK_GRANTS, MOCK_MESSAGES, MOCK_PROFILE, MOCK_SCHEDULES } from "./mock-data"
import type {
  Activity,
  ActivityStep,
  AssistantMessage,
  AuditDecision,
  AuditRecord,
  ProfileFile,
  ProfileFileName,
  ScheduleItem,
  StandingGrant,
} from "./types"

interface AssistantPageProps {
  /** With the app sidebar collapsed the header clears the traffic lights and offers to expand it. */
  sidebarCollapsed: boolean
  onExpandSidebar: () => void
}

let seq = 0
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${++seq}`

/**
 * The personal assistant, shown in place of the editor (center + right) with the
 * app sidebar still on the left: the thread in the middle, what it is doing on the right.
 *
 * UI prototype — state is local and the "assistant" is a scripted simulation so
 * the flows (dispatch → progress → report, approvals, follow-ups) can be felt
 * before the runtime exists. See docs/assistant/design.md.
 */
export function AssistantPage({ sidebarCollapsed, onExpandSidebar }: AssistantPageProps) {
  const [messages, setMessages] = useState<AssistantMessage[]>(MOCK_MESSAGES)
  const [activities, setActivities] = useState<Activity[]>(MOCK_ACTIVITIES)
  const [audit, setAudit] = useState<AuditRecord[]>(MOCK_AUDIT)
  const [grants, setGrants] = useState<StandingGrant[]>(MOCK_GRANTS)
  const [schedules, setSchedules] = useState<ScheduleItem[]>(MOCK_SCHEDULES)
  const [profile, setProfile] = useState<ProfileFile[]>(MOCK_PROFILE)
  const [typing, setTyping] = useState(false)
  const [tab, setTab] = useState<SidePanelTab>("activity")
  /** The definition file open in the drawer. Only one drawer shows at a time. */
  const [openFile, setOpenFile] = useState<ProfileFileName | null>(null)
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null)

  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])
  const later = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms))
  }, [])

  const identity = parseIdentity(profile.find((f) => f.name === "identity")?.content ?? "")
  const assistantName = identity.name ?? "Assistant"
  const busyCount = activities.filter((a) => a.status === "running" || a.status === "waiting").length
  const selectedActivity = useMemo(
    () => activities.find((a) => a.id === selectedActivityId) ?? null,
    [activities, selectedActivityId],
  )

  // --- simulation helpers -------------------------------------------------

  const say = useCallback((msg: Omit<AssistantMessage, "id" | "role" | "createdAt">) => {
    setMessages((prev) => [...prev, { id: nextId("m"), role: "assistant", createdAt: Date.now(), ...msg }])
  }, [])

  const patchActivity = useCallback((id: string, patch: (a: Activity) => Partial<Activity>) => {
    setActivities((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch(a) } : a)))
  }, [])

  const addStep = useCallback(
    (id: string, step: Omit<ActivityStep, "id" | "at">) => {
      patchActivity(id, (a) => ({
        steps: [
          ...a.steps.map((s) => (s.status === "running" ? { ...s, status: "done" as const } : s)),
          { ...step, id: nextId("s"), at: Date.now() },
        ],
      }))
    },
    [patchActivity],
  )

  const finish = useCallback(
    (id: string, title: string) => {
      addStep(id, { label: "Wrote up the result", status: "done", tool: "report_result" })
      patchActivity(id, () => ({
        status: "done",
        finishedAt: Date.now(),
        summary: "Finished",
        report: `「${title}」已经处理完。\n\n这是原型里的模拟结果：真实情况下这里是 worker 的结构化摘要和产物。`,
      }))
      say({ text: `搞定了：${title}。`, trigger: { kind: "worker", activityId: id }, activityId: id })
    },
    [addStep, patchActivity, say],
  )

  // --- user actions -------------------------------------------------------

  const handleSend = (text: string) => {
    setMessages((prev) => [...prev, { id: nextId("m"), role: "user", text, createdAt: Date.now() }])
    setTyping(true)

    const id = nextId("act")
    const title = text.length > 28 ? `${text.slice(0, 28)}…` : text
    const needsApproval = /邮件|email|mail|发给|发送|send/i.test(text)

    later(700, () => {
      setTyping(false)
      say({ text: "好，我去办，好了告诉你。", activityId: id })
      setActivities((prev) => [
        { id, title, summary: "Working…", status: "running", startedAt: Date.now(), steps: [] },
        ...prev,
      ])
      addStep(id, { label: "Worked out what's needed", status: "running", tool: "plan" })
    })

    later(1900, () => addStep(id, { label: "Gathered the details", status: "running", tool: "web_search", args: { q: text } }))

    if (needsApproval) {
      later(3200, () => {
        addStep(id, { label: "Waiting for approval to send mail", status: "running", tool: "gmail_send", args: { to: "…", subject: title } })
        patchActivity(id, () => ({ status: "waiting", summary: "Waiting for your approval" }))
        say({
          text: "邮件写好了，发之前需要你点一下头。",
          activityId: id,
          approval: {
            id: nextId("ap"),
            title: "Send mail in Gmail",
            intent: `Send the drafted email for "${title}".`,
            icon: "mail",
            args: { to: "someone@example.com", subject: title, body: "…" },
          },
        })
      })
    } else {
      later(4600, () => finish(id, title))
    }
  }

  const handleDecide = (messageId: string, decision: AuditDecision) => {
    const msg = messages.find((m) => m.id === messageId)
    const approval = msg?.approval
    if (!msg || !approval || approval.decision) return

    setMessages((prev) => prev.map((m) => (m.id === messageId && m.approval ? { ...m, approval: { ...m.approval, decision } } : m)))
    setAudit((prev) => [
      { id: nextId("a"), title: approval.title, intent: approval.intent, icon: approval.icon, decision, at: Date.now(), args: approval.args },
      ...prev,
    ])
    if (decision === "always_allowed") {
      setGrants((prev) => [...prev, { id: nextId("g"), title: approval.title, icon: approval.icon, grantedAt: Date.now() }])
    }

    const activityId = msg.activityId
    if (!activityId) return
    if (decision === "denied") {
      patchActivity(activityId, (a) => ({
        status: "stopped",
        finishedAt: Date.now(),
        summary: "You declined sending the mail",
        steps: a.steps.map((s) => (s.status === "running" ? { ...s, status: "failed" as const } : s)),
      }))
      later(500, () => say({ text: "好，那我先不发了，草稿留着。", activityId }))
      return
    }
    patchActivity(activityId, () => ({ status: "running", summary: "Sending…" }))
    const title = activities.find((a) => a.id === activityId)?.title ?? ""
    later(1200, () => finish(activityId, title))
  }

  const handleStop = (id: string) => {
    patchActivity(id, (a) => ({
      status: "stopped",
      finishedAt: Date.now(),
      summary: "Stopped by you",
      steps: a.steps.map((s) => (s.status === "running" ? { ...s, status: "failed" as const } : s)),
    }))
    say({ text: "停下来了。", activityId: id })
  }

  const handleFollowUp = (id: string, text: string) => {
    const activity = activities.find((a) => a.id === id)
    if (!activity) return
    addStep(id, { label: `You said: ${text}`, status: "running", tool: "steer", args: { text } })
    if (activity.status !== "running" && activity.status !== "waiting") {
      patchActivity(id, () => ({ status: "running", summary: "Working on your follow-up…", finishedAt: undefined }))
      later(2500, () => finish(id, activity.title))
    }
  }

  const openActivity = (id: string) => {
    setOpenFile(null)
    setTab("activity")
    setSelectedActivityId(id)
  }

  const openProfileFile = (file: ProfileFileName) => {
    setSelectedActivityId(null)
    setOpenFile(file)
  }

  const saveProfile = (name: ProfileFileName, content: string) => {
    setProfile((prev) => prev.map((f) => (f.name === name ? { ...f, content, updatedAt: Date.now(), updatedBy: "user" } : f)))
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
        <main className="min-w-0 flex-1">
          <AssistantChat
            messages={messages}
            typing={typing}
            userName={identity.userName}
            highlightedActivityId={selectedActivityId}
            onSend={handleSend}
            onOpenActivity={openActivity}
            onDecide={handleDecide}
            onOpenMemory={() => openProfileFile("memory")}
          />
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
              <AuditTab records={audit} grants={grants} onRevoke={(gid) => setGrants((prev) => prev.filter((g) => g.id !== gid))} />
            )}
            {tab === "schedule" && (
              <ScheduleTab
                schedules={schedules}
                onToggle={(sid) => setSchedules((prev) => prev.map((s) => (s.id === sid ? { ...s, enabled: !s.enabled } : s)))}
                onDelete={(sid) => setSchedules((prev) => prev.filter((s) => s.id !== sid))}
                onEditHeartbeat={() => openProfileFile("heartbeat")}
              />
            )}
            {tab === "profile" && (
              <ProfileTab
                files={profile}
                assistantName={assistantName}
                onOpenFile={openProfileFile}
              />
            )}
          </AssistantSidePanel>
        </aside>

        <ActivityDrawer
          activity={selectedActivity}
          onClose={() => setSelectedActivityId(null)}
          onStop={handleStop}
          onFollowUp={handleFollowUp}
        />
        <ProfileFileDrawer
          file={profile.find((f) => f.name === openFile) ?? null}
          assistantName={assistantName}
          onClose={() => setOpenFile(null)}
          onSave={saveProfile}
        />
      </div>
    </div>
  )
}
