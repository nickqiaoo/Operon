import { useEffect, useState } from "react"
import { toast } from "sonner"
import { ArrowLeft, Bot, Hash, Plus, Settings2 } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { useChannelStore } from "@/stores/channel-store"
import { useProjectStore } from "@/stores/project-store"
import { ChannelChat } from "@/components/channel/ChannelChat"
import { ProjectAgentDialog } from "@/components/channel/AgentMenu"
import { AgentManageDialog } from "@/components/channel/AgentManageDialog"
import { AgentAvatar } from "@/components/icons/AgentAvatar"
import type { Agent } from "@/types/channel"
import { TasksPage } from "@/components/task/TasksPage"
import { MobileSheet } from "./MobileSheet"
import { hasNativeTabBar, NativeShell } from "@/lib/native"
import { useBackHandler } from "@/hooks/useAndroidBackButton"

/**
 * A project's tasks on a phone — the single-column {@link ChannelPage}. The tasks
 * fill the tab, as a list (a board column at a time is too narrow a view);
 * channels sit behind a button at the end of its toolbar and open as pages
 * pushed over it (the list, then a conversation), each with a back.
 * Reuses {@link TasksPage} and {@link ChannelChat} unchanged.
 */
export function MobileChannelScreen({
  keyboardOpen = false,
  openTaskId,
  onDeepLinkConsumed,
}: {
  /** Soft keyboard is up — the channel/thread composers lift above it. */
  keyboardOpen?: boolean
  /** Inbox deep-link: open this task's detail on the board. */
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

  // A list pushed over the tasks — the channels (a conversation then goes over that), or the
  // agents the tasks are assigned to.
  const [page, setPage] = useState<"channels" | "agents" | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  // Deep-link target forwarded to TasksPage.
  const [pendingTaskId, setPendingTaskId] = useState<number | null>(null)

  useEffect(() => {
    if (activeProjectId == null) return
    setActiveChannel(null)
    setPage(null)
    void Promise.all([loadAgents(), loadChannels(activeProjectId), loadSessions(activeProjectId)])
  }, [activeProjectId, loadAgents, loadChannels, loadSessions, setActiveChannel])

  // Deep-link: a task notification lands on the board, out from under any open
  // channel, and hands the target down to TasksPage. Declared after the reset
  // effect so it wins when both fire on entry.
  useEffect(() => {
    if (openTaskId == null) return
    setActiveChannel(null)
    setPage(null)
    setPendingTaskId(openTaskId)
    onDeepLinkConsumed?.()
  }, [openTaskId, onDeepLinkConsumed, setActiveChannel])

  // Android back / the iOS top bar's back pops one page at a time.
  useBackHandler(activeChannelId != null || page != null, () => {
    if (activeChannelId != null) setActiveChannel(null)
    else setPage(null)
  })

  if (activeProjectId == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <Hash className="size-6 text-muted-foreground/60" />
        <p className="text-base font-medium text-foreground/85">
          <FormattedMessage id="mobile.channel.noProjectTitle" defaultMessage="No project selected" />
        </p>
        <p className="text-[13px] text-muted-foreground/70">
          <FormattedMessage id="mobile.channel.noProjectDesc" defaultMessage="Pick a project from the bar above." />
        </p>
      </div>
    )
  }

  const openWorkspace = (workspaceId: number) => setActiveWorkspace(workspaceId, activeProjectId)

  // A channel is open → full-screen conversation, back to the list.
  if (activeChannelId != null) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-11 shrink-0 items-center border-b border-border/50 px-2">
          <button
            type="button"
            onClick={() => setActiveChannel(null)}
            className="flex items-center gap-1 rounded-md px-2 py-1.5 text-base text-muted-foreground hover:bg-muted/50 hover:text-foreground"
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

  // Packaged apps: the system alert with a text field is the native shape of
  // "name one thing"; the web sheet stays for the browser.
  const startCreating = async () => {
    if (!hasNativeTabBar()) {
      setCreating(true)
      return
    }
    try {
      const { value } = await NativeShell.promptText({
        title: intl.formatMessage({ id: "mobile.channel.newChannel", defaultMessage: "New channel" }),
        placeholder: intl.formatMessage({ id: "mobile.channel.namePlaceholder", defaultMessage: "channel-name" }),
        confirmLabel: intl.formatMessage({ id: "common.create", defaultMessage: "Create" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel", defaultMessage: "Cancel" }),
      })
      if (value) await createNew(value)
    } catch {
      setCreating(true)
    }
  }

  const createNew = async (nameArg?: string) => {
    const name = (nameArg ?? newName).trim()
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

  const createSheet = (
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
          className="w-full min-w-0 rounded-lg border border-border/50 bg-muted/30 px-4 py-2 text-base font-medium text-foreground/85 hover:bg-muted/50 disabled:opacity-40"
        >
          <FormattedMessage id="common.create" defaultMessage="Create" />
        </button>
      </div>
    </MobileSheet>
  )

  // The channel list, pushed over the board.
  if (page === "agents") {
    return <AgentsPage projectId={activeProjectId} onBack={() => setPage(null)} onOpenWorkspace={openWorkspace} />
  }

  if (page === "channels") {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/50 px-2">
          <button
            type="button"
            onClick={() => setPage(null)}
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-base text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            <FormattedMessage id="mobile.tab.channel" defaultMessage="Board" />
          </button>
          <span className="min-w-0 flex-1 truncate text-center text-base font-semibold text-foreground/90">
            <FormattedMessage id="mobile.channel.channels" defaultMessage="Channels" />
          </span>
          <button
            type="button"
            onClick={() => void startCreating()}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
            aria-label={intl.formatMessage({ id: "mobile.channel.newChannel", defaultMessage: "New channel" })}
          >
            <Plus className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1">
          {channels.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
              <Hash className="size-6 text-muted-foreground/60" />
              <p className="text-base font-medium text-foreground/85">
                <FormattedMessage id="mobile.channel.emptyTitle" defaultMessage="No channels yet" />
              </p>
              <p className="text-[13px] text-muted-foreground/70">
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
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left hover:bg-secondary-hover"
                >
                  <Hash className="size-4 shrink-0 text-muted-foreground/60" />
                  <span className="truncate text-base text-foreground/85">{channel.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {createSheet}
      </div>
    )
  }

  return (
    <TasksPage
      projectId={activeProjectId}
      onOpenWorkspace={openWorkspace}
      initialTaskId={pendingTaskId}
      onInitialTaskConsumed={() => setPendingTaskId(null)}
      initialView="list"
      toolbarEnd={
        <>
          <button
            type="button"
            onClick={() => setPage("agents")}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
            aria-label={intl.formatMessage({ id: "channel.section.agents", defaultMessage: "Agents" })}
          >
            <Bot className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => setPage("channels")}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
            aria-label={intl.formatMessage({ id: "mobile.channel.channels", defaultMessage: "Channels" })}
          >
            <Hash className="size-4" />
          </button>
        </>
      }
    />
  )
}

/**
 * The agents tasks are assigned to, pushed over the tasks: one opens its sessions here (stop /
 * reset); the button in the bar creates and edits them.
 */
function AgentsPage({
  projectId,
  onBack,
  onOpenWorkspace,
}: {
  projectId: number
  onBack: () => void
  onOpenWorkspace: (workspaceId: number) => void
}) {
  const intl = useIntl()
  const agents = useChannelStore((s) => s.agents)
  const [detail, setDetail] = useState<Agent | null>(null)
  const [manage, setManage] = useState(false)

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/50 px-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-base text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          <FormattedMessage id="mobile.tab.channel" defaultMessage="Board" />
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-base font-semibold text-foreground/90">
          <FormattedMessage id="channel.section.agents" defaultMessage="Agents" />
        </span>
        <button
          type="button"
          onClick={() => setManage(true)}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
          aria-label={intl.formatMessage({ id: "channel.manageAgents", defaultMessage: "Manage Agents" })}
        >
          <Settings2 className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {agents.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <Bot className="size-6 text-muted-foreground/60" />
            <p className="text-base font-medium text-foreground/85">
              <FormattedMessage id="channel.noAgents" defaultMessage="No agents yet" />
            </p>
          </div>
        ) : (
          <div className="h-full overflow-y-auto p-2">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => setDetail(agent)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-secondary-hover"
              >
                <AgentAvatar provider={agent.provider} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base text-foreground/85">{agent.name}</span>
                  <span className="block truncate text-[13px] text-muted-foreground/70">
                    {agent.provider}
                    {agent.model ? ` · ${agent.model}` : ""}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {detail && (
        <ProjectAgentDialog
          agent={detail}
          projectId={projectId}
          onClose={() => setDetail(null)}
          onOpenWorkspace={(id) => {
            setDetail(null)
            onOpenWorkspace(id)
          }}
        />
      )}
      {manage && <AgentManageDialog open onClose={() => setManage(false)} />}
    </div>
  )
}
