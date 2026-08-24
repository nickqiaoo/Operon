import { useEffect, useState } from "react"
import { toast } from "sonner"
import { ArrowLeft, Hash, ListTodo, MessageSquare, Plus } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { cn } from "@/lib/utils"
import { useChannelStore } from "@/stores/channel-store"
import { useProjectStore } from "@/stores/project-store"
import { ChannelChat } from "@/components/channel/ChannelChat"
import { TasksPage } from "@/components/task/TasksPage"
import { MobileSheet } from "./MobileSheet"

type HubView = "channels" | "tasks"

/**
 * The per-project collaboration hub — a single-column adaptation of the desktop
 * {@link ChannelPage}. Its `Channels ⇄ Tasks` segmented switch mirrors that
 * page's own `view` state, and it reuses {@link ChannelChat}, {@link TasksPage}
 * (and therefore the task create/dispatch dialogs) unchanged. Faithful to the
 * desktop design where Tasks has no entry of its own — it lives beside Channels
 * inside this hub.
 */
export function MobileChannelScreen({
  keyboardOpen = false,
  openTaskId,
  onDeepLinkConsumed,
}: {
  /** Soft keyboard is up — the channel/thread composers lift above it. */
  keyboardOpen?: boolean
  /** Inbox deep-link: jump to Tasks and open this task's detail. */
  openTaskId?: number | null
  onDeepLinkConsumed?: () => void
} = {}) {
  const intl = useIntl()
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const setActiveWorkspace = useProjectStore((s) => s.setActiveWorkspace)

  const channels = useChannelStore((s) => s.channels)
  const activeChannelId = useChannelStore((s) => s.activeChannelId)
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel)
  const loadAgents = useChannelStore((s) => s.loadAgents)
  const loadChannels = useChannelStore((s) => s.loadChannels)
  const loadSessions = useChannelStore((s) => s.loadSessions)
  const createChannel = useChannelStore((s) => s.createChannel)

  const [view, setView] = useState<HubView>("channels")
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  // Deep-link target forwarded to TasksPage once the Tasks view is active.
  const [pendingTaskId, setPendingTaskId] = useState<number | null>(null)

  useEffect(() => {
    if (activeProjectId == null) return
    setActiveChannel(null)
    setView("channels")
    void Promise.all([loadAgents(), loadChannels(activeProjectId), loadSessions(activeProjectId)])
  }, [activeProjectId, loadAgents, loadChannels, loadSessions, setActiveChannel])

  // Deep-link: a task notification lands on Tasks (not the default Channels view)
  // and hands the target down to TasksPage. Declared after the reset effect so it
  // wins when both fire on entry.
  useEffect(() => {
    if (openTaskId == null) return
    setView("tasks")
    setPendingTaskId(openTaskId)
    onDeepLinkConsumed?.()
  }, [openTaskId, onDeepLinkConsumed])

  if (activeProjectId == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <Hash className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium text-foreground/85">
          <FormattedMessage id="mobile.channel.noProjectTitle" defaultMessage="No project selected" />
        </p>
        <p className="text-xs text-muted-foreground/70">
          <FormattedMessage id="mobile.channel.noProjectDesc" defaultMessage="Pick a project from the bar above." />
        </p>
      </div>
    )
  }

  const openWorkspace = (workspaceId: number) => setActiveWorkspace(workspaceId, activeProjectId)

  // A channel is open → full-screen conversation with a back affordance.
  if (view === "channels" && activeChannelId != null) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-11 shrink-0 items-center border-b border-border/50 px-2">
          <button
            type="button"
            onClick={() => setActiveChannel(null)}
            className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            <FormattedMessage id="mobile.channel.channels" defaultMessage="Channels" />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <ChannelChat key={activeChannelId} channelId={activeChannelId} mobileKeyboardOpen={keyboardOpen} />
        </div>
      </div>
    )
  }

  const createNew = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      const channel = await createChannel(activeProjectId, name)
      setNewName("")
      setCreating(false)
      setActiveChannel(channel.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create channel")
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Channels ⇄ Tasks segmented switch — mirrors ChannelPage's `view`. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
        <div className="flex flex-1 rounded-lg bg-muted/40 p-0.5">
          <SegButton active={view === "channels"} onClick={() => setView("channels")} Icon={MessageSquare}>
            <FormattedMessage id="mobile.channel.channels" defaultMessage="Channels" />
          </SegButton>
          <SegButton active={view === "tasks"} onClick={() => setView("tasks")} Icon={ListTodo}>
            <FormattedMessage id="mobile.channel.tasks" defaultMessage="Tasks" />
          </SegButton>
        </div>
        {view === "channels" && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            aria-label={intl.formatMessage({ id: "mobile.channel.newChannel", defaultMessage: "New channel" })}
          >
            <Plus className="size-4" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {view === "tasks" ? (
          <TasksPage
            projectId={activeProjectId}
            onOpenWorkspace={openWorkspace}
            initialTaskId={pendingTaskId}
            onInitialTaskConsumed={() => setPendingTaskId(null)}
          />
        ) : channels.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <Hash className="size-6 text-muted-foreground/60" />
            <p className="text-sm font-medium text-foreground/85">
              <FormattedMessage id="mobile.channel.emptyTitle" defaultMessage="No channels yet" />
            </p>
            <p className="text-xs text-muted-foreground/70">
              <FormattedMessage id="mobile.channel.emptyDesc" defaultMessage="Create one to start collaborating." />
            </p>
          </div>
        ) : (
          <div className="h-full overflow-y-auto p-2">
            {channels.map((channel) => (
              <button
                key={channel.id}
                type="button"
                onClick={() => setActiveChannel(channel.id)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left hover:bg-muted/40"
              >
                <Hash className="size-4 shrink-0 text-muted-foreground/60" />
                <span className="truncate text-sm text-foreground/85">{channel.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <MobileSheet
        open={creating}
        onClose={() => setCreating(false)}
        title={intl.formatMessage({ id: "mobile.channel.newChannel", defaultMessage: "New channel" })}
      >
        <div className="min-w-0 space-y-3 px-2 py-1">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createNew()
            }}
            placeholder={intl.formatMessage({ id: "mobile.channel.namePlaceholder", defaultMessage: "channel-name" })}
            className="w-full min-w-0 rounded-lg border border-border/50 bg-background px-3 py-2 text-base outline-none focus:border-border"
          />
          <button
            type="button"
            onClick={() => void createNew()}
            disabled={!newName.trim()}
            className="w-full min-w-0 rounded-lg border border-border/50 bg-muted/30 px-4 py-2 text-sm font-medium text-foreground/85 hover:bg-muted/50 disabled:opacity-40"
          >
            <FormattedMessage id="common.create" defaultMessage="Create" />
          </button>
        </div>
      </MobileSheet>
    </div>
  )
}

function SegButton({
  active,
  onClick,
  Icon,
  children,
}: {
  active: boolean
  onClick: () => void
  Icon: typeof MessageSquare
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors",
        active ? "bg-background text-foreground shadow-card" : "text-muted-foreground/70 hover:text-muted-foreground"
      )}
    >
      <Icon className="size-3.5" />
      {children}
    </button>
  )
}
