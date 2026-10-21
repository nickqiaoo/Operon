import { Fragment, useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { ArrowLeft, Bot, Folder, Hash, ListFilter, Plus, Settings2 } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { cn } from "@/lib/utils"
import { useChannelStore } from "@/stores/channel-store"
import { useProjectStore } from "@/stores/project-store"
import { ChannelChat } from "@/components/channel/ChannelChat"
import { ProjectAgentDialog } from "@/components/channel/AgentMenu"
import { AgentManageDialog } from "@/components/channel/AgentManageDialog"
import { AgentAvatar } from "@/components/icons/AgentAvatar"
import type { Agent } from "@/types/channel"
import { TasksPage, type GroupBy, type TaskViewControls } from "@/components/task/TasksPage"
import { STATUS_MESSAGES, priorityMessage } from "@/components/task/task-i18n"
import { TASK_PRIORITIES, TASK_STATUSES } from "@/types/task"
import { MobileNewTaskPage } from "./MobileNewTaskPage"
import { useTaskStore } from "@/stores/task-store"
import { useTaskStream } from "@/hooks/useTaskStream"
import { MobileSheet } from "./MobileSheet"
import { hasNativeTabBar, NativeShell } from "@/lib/native"
import { useBackHandler } from "@/hooks/useAndroidBackButton"
import { MobileHeader, useMobileContentBottom, useMobileContentOffset, useMobileTopInset, type MobileMenuNode } from "./MobileHeader"
import type { SpecChatRef } from "@shared/spec"

type Section = "tasks" | "channels"

const DEFAULT_CONTROLS: TaskViewControls = {
  groupBy: "status",
  status: "all",
  priority: "all",
  assignee: "all",
  showArchived: false,
}

/**
 * Every project's tasks and channels on a phone — the single-column {@link BoardPage}.
 * The desktop's two sidebar entries are the two halves of a switch at the top;
 * the bar above narrows both to one project ({@link MobileApp} owns that filter).
 * Tasks show as a list (a board column at a time is too narrow a view); a channel
 * opens as a conversation pushed over the list, with a back.
 * Reuses {@link TasksPage} and {@link ChannelChat} unchanged.
 */
export function MobileChannelScreen({
  keyboardOpen = false,
  projectFilter,
  onProjectFilterChange,
  openTaskId,
  onDeepLinkConsumed,
  onImmersiveChange,
  onOpenChat,
}: {
  /** Opens a conversation a task links to (a spec's agents and tickets). */
  onOpenChat?: (chat: SpecChatRef) => void
  /** Soft keyboard is up — the channel/thread composers lift above it. */
  keyboardOpen?: boolean
  /** A conversation is open: the shell hides its bars, as for a chat. */
  onImmersiveChange?: (immersive: boolean) => void
  /** One project's tasks and channels, or null for every project's. */
  projectFilter: number | null
  onProjectFilterChange: (projectId: number | null) => void
  /** Inbox deep-link: open this task's detail on the board. */
  openTaskId?: number | null
  onDeepLinkConsumed?: () => void
}) {
  const intl = useIntl()
  const projects = useProjectStore((s) => s.projects)
  const setActiveWorkspace = useProjectStore((s) => s.setActiveWorkspace)
  const loadTasks = useTaskStore((s) => s.load)
  const openDetail = useTaskStore((s) => s.openDetail)
  const taskDetailOpen = useTaskStore((s) => s.detail != null)
  // The tasks' grouping and filters: the desktop toolbar's, kept in the header's menu here.
  const [controls, setControls] = useState<TaskViewControls>(DEFAULT_CONTROLS)

  const channels = useChannelStore((s) => s.channels)
  const activeChannelId = useChannelStore((s) => s.activeChannelId)
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel)
  const loadAgents = useChannelStore((s) => s.loadAgents)
  const loadChannels = useChannelStore((s) => s.loadChannels)
  const loadSessions = useChannelStore((s) => s.loadSessions)
  const createChannel = useChannelStore((s) => s.createChannel)

  const [section, setSection] = useState<Section>("tasks")
  // The agents the tasks are assigned to, pushed over either half.
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  // A new channel lives in a project: the filtered one, else picked in the sheet.
  const [newProjectId, setNewProjectId] = useState<number | null>(null)
  // Deep-link target forwarded to TasksPage.
  const [pendingTaskId, setPendingTaskId] = useState<number | null>(null)
  const [channelFocus, setChannelFocus] = useState<number | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const agents = useChannelStore((s) => s.agents)
  const topInset = useMobileTopInset()
  const contentOffset = useMobileContentOffset()
  const contentBottom = useMobileContentBottom()

  // An open channel is a conversation like a chat, and a new task a compose page:
  // the shell's bars step aside and the page's own header row is the only one.
  const immersive = activeChannelId != null || newTaskOpen
  useEffect(() => {
    onImmersiveChange?.(immersive)
  }, [immersive, onImmersiveChange])
  useEffect(() => () => onImmersiveChange?.(false), [onImmersiveChange])

  useEffect(() => {
    setActiveChannel(null)
    void Promise.all([loadAgents(), loadChannels(null), loadSessions(null), loadTasks(null)])
  }, [loadAgents, loadChannels, loadSessions, loadTasks, setActiveChannel])
  useTaskStream(null)

  // A task chip under a channel message: over to the tasks, its detail open.
  const openTask = useCallback((taskId: number) => {
    void openDetail(taskId)
    setActiveChannel(null)
    setSection("tasks")
  }, [openDetail, setActiveChannel])

  // Deep-link: a task notification lands on the tasks, out from under any open
  // channel, and hands the target down to TasksPage. Declared after the load
  // effect so it wins when both fire on entry.
  useEffect(() => {
    if (openTaskId == null) return
    setActiveChannel(null)
    setAgentsOpen(false)
    setSection("tasks")
    setPendingTaskId(openTaskId)
    onDeepLinkConsumed?.()
  }, [openTaskId, onDeepLinkConsumed, setActiveChannel])

  // Android back / the iOS top bar's back pops one page at a time.
  useBackHandler(activeChannelId != null || agentsOpen || newTaskOpen, () => {
    if (newTaskOpen) setNewTaskOpen(false)
    else if (activeChannelId != null) setActiveChannel(null)
    else setAgentsOpen(false)
  })

  const openWorkspace = (workspaceId: number) => {
    const project = projects.find((p) => p.workspaces.some((w) => w.id === workspaceId))
    if (project) setActiveWorkspace(workspaceId, project.id)
  }

  if (newTaskOpen) {
    return (
      <MobileNewTaskPage
        agents={agents}
        defaultProjectId={projectFilter}
        keyboardOpen={keyboardOpen}
        onCancel={() => setNewTaskOpen(false)}
        onCreated={(id) => {
          setNewTaskOpen(false)
          setSection("tasks")
          void openDetail(id)
        }}
      />
    )
  }

  // A channel is open → full-screen conversation. With the shell's bars gone the
  // safe-area insets are ours; the bottom one is dropped while the keyboard is
  // up, where the composer lifts itself above it.
  if (activeChannelId != null) {
    return (
      <div
        className="flex h-full flex-col"
        // The bottom inset is the floating composer's to clear (ChannelChat):
        // the transcript runs on to the screen's edge under it.
        style={{ paddingTop: topInset }}
      >
        <div className="min-h-0 flex-1">
          <ChannelChat
            key={activeChannelId}
            channelId={activeChannelId}
            onBack={() => setActiveChannel(null)}
            mobileKeyboardOpen={keyboardOpen}
            onOpenTask={openTask}
            focusMessageId={channelFocus}
            onFocusConsumed={() => setChannelFocus(null)}
          />
        </div>
      </div>
    )
  }

  if (agentsOpen) {
    return <AgentsPage projectId={projectFilter} onBack={() => setAgentsOpen(false)} onOpenWorkspace={openWorkspace} />
  }

  const createNew = async (projectId: number | null, nameArg?: string) => {
    const name = (nameArg ?? newName).trim()
    if (!name || projectId == null) return
    try {
      const channel = await createChannel(projectId, name)
      setNewName("")
      setCreating(false)
      setActiveChannel(channel.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create channel")
    }
  }

  // Packaged apps: the system alert with a text field is the native shape of
  // "name one thing" — when the project is already known. Across projects the
  // web sheet asks for both.
  const startCreating = async () => {
    const filtered = projects.find((p) => p.id === projectFilter) ?? null
    if (!filtered || !hasNativeTabBar()) {
      setNewProjectId(filtered?.id ?? null)
      setCreating(true)
      return
    }
    try {
      const { value } = await NativeShell.promptText({
        title: intl.formatMessage(
          { id: "mobile.channel.newChannelIn", defaultMessage: "New channel in {project}" },
          { project: filtered.name },
        ),
        placeholder: intl.formatMessage({ id: "mobile.channel.namePlaceholder", defaultMessage: "channel-name" }),
        confirmLabel: intl.formatMessage({ id: "common.create", defaultMessage: "Create" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel", defaultMessage: "Cancel" }),
      })
      if (value) await createNew(filtered.id, value)
    } catch {
      setNewProjectId(filtered.id)
      setCreating(true)
    }
  }

  const createSheet = (
    <MobileSheet
      open={creating}
      onClose={() => setCreating(false)}
      title={intl.formatMessage({ id: "mobile.channel.newChannel", defaultMessage: "New channel" })}
    >
      <div className="min-w-0 space-y-3 px-2 py-1">
        {/* Agents in a channel work in its project's repository, so it needs one. */}
        <div className="flex flex-wrap gap-1.5">
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setNewProjectId(p.id)}
              className={cn(
                "flex min-w-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors",
                newProjectId === p.id
                  ? "border-border bg-row-selected text-foreground"
                  : "border-border/50 text-muted-foreground hover:bg-row-hover",
              )}
            >
              <Folder className="size-3.5 shrink-0" />
              <span className="truncate">{p.name}</span>
            </button>
          ))}
        </div>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void createNew(newProjectId)
          }}
          placeholder={intl.formatMessage({ id: "mobile.channel.namePlaceholder", defaultMessage: "channel-name" })}
          className="w-full min-w-0 rounded-lg border border-border/50 bg-background px-3 py-2 text-base outline-none focus:border-border"
        />
        <button
          type="button"
          onClick={() => void createNew(newProjectId)}
          disabled={!newName.trim() || newProjectId == null}
          className="w-full min-w-0 rounded-lg border border-border/50 bg-muted/30 px-4 py-2 text-base font-medium text-foreground/85 hover:bg-row-hover disabled:opacity-40"
        >
          <FormattedMessage id="common.create" defaultMessage="Create" />
        </button>
      </div>
    </MobileSheet>
  )

  const visibleProjects = projectFilter == null ? projects : projects.filter((p) => p.id === projectFilter)
  const groups = visibleProjects
    .map((project) => ({ project, list: channels.filter((c) => c.projectId === project.id) }))
    .filter((g) => g.list.length > 0)


  const showingTaskDetail = section === "tasks" && taskDetailOpen
  const filtering =
    projectFilter != null ||
    (section === "tasks" &&
      (controls.status !== "all" || controls.priority !== "all" || controls.assignee !== "all" || controls.showArchived))

  // The header's filter menu. The project narrows both halves; the rest is the
  // desktop toolbar's grouping and filters, for the tasks.
  const choice = (id: string, label: string, selected: boolean): MobileMenuNode => ({ kind: "item", id, label, selected })
  // A submenu's row names its current choice.
  const submenu = (id: string, label: string, children: MobileMenuNode[]): MobileMenuNode => ({
    kind: "group",
    id,
    label,
    detail: children.find((c) => c.kind === "item" && c.selected)?.label,
    children,
  })
  const allProjects = intl.formatMessage({ id: "board.allProjects", defaultMessage: "All projects" })
  const menuNodes: MobileMenuNode[] = [
    {
      kind: "group",
      id: "project",
      label: intl.formatMessage({ id: "task.new.project", defaultMessage: "Project" }),
      inline: true,
      children: [
        choice("project:all", allProjects, projectFilter == null),
        ...projects.map((p) => choice(`project:${p.id}`, p.name, p.id === projectFilter)),
      ],
    },
  ]
  if (section === "tasks") {
    const all = (id: string, fallback: string) => intl.formatMessage({ id, defaultMessage: fallback })
    menuNodes.push({
      kind: "group",
      id: "view",
      label: intl.formatMessage({ id: "mobile.board.menu.view", defaultMessage: "View" }),
      inline: true,
      children: [
        submenu("groupBy", intl.formatMessage({ id: "mobile.board.menu.groupBy", defaultMessage: "Group by" }), (
          [["status", "Status"], ["priority", "Priority"], ["assignee", "Assignee"]] as const
        ).map(([key, fallback]) => choice(`groupBy:${key}`, intl.formatMessage({ id: `task.groupBy.${key}`, defaultMessage: fallback }), controls.groupBy === key))),
        submenu("status", intl.formatMessage({ id: "task.groupBy.status", defaultMessage: "Status" }), [
          choice("status:all", all("task.toolbar.allStatus", "All status"), controls.status === "all"),
          ...TASK_STATUSES.map((st) => choice(`status:${st}`, intl.formatMessage(STATUS_MESSAGES[st]), controls.status === st)),
        ]),
        submenu("priority", intl.formatMessage({ id: "task.groupBy.priority", defaultMessage: "Priority" }), [
          choice("priority:all", all("task.toolbar.allPriority", "All priority"), controls.priority === "all"),
          ...[...TASK_PRIORITIES].reverse().map((p) => choice(`priority:${p}`, intl.formatMessage(priorityMessage(p)), controls.priority === String(p))),
        ]),
        submenu("assignee", intl.formatMessage({ id: "task.assignee", defaultMessage: "Assignee" }), [
          choice("assignee:all", all("task.toolbar.allAssignees", "All assignees"), controls.assignee === "all"),
          choice("assignee:unassigned", intl.formatMessage({ id: "task.unassigned", defaultMessage: "Unassigned" }), controls.assignee === "unassigned"),
          ...agents.map((a) => choice(`assignee:${a.id}`, a.name, controls.assignee === String(a.id))),
        ]),
        choice("archived", intl.formatMessage({ id: "mobile.board.menu.showArchived", defaultMessage: "Show archived" }), controls.showArchived),
      ],
    })
    // A command, not a choice: no `selected`, so nothing ticks it.
    menuNodes.push({ kind: "item", id: "agents", label: intl.formatMessage({ id: "channel.manageAgents", defaultMessage: "Manage Agents" }) })
  }

  const selectMenu = (id: string) => {
    const [key, value = ""] = id.split(":")
    if (key === "project") onProjectFilterChange(value === "all" ? null : Number(value))
    else if (key === "groupBy") setControls((c) => ({ ...c, groupBy: value as GroupBy }))
    else if (key === "status" || key === "priority" || key === "assignee") setControls((c) => ({ ...c, [key]: value }))
    else if (key === "archived") setControls((c) => ({ ...c, showArchived: !c.showArchived }))
    else if (key === "agents") setAgentsOpen(true)
  }

  return (
    <div className="flex h-full flex-col">
      {/* One row: the two halves as equals (the desktop gives each its own sidebar
          entry), then the filter menu, New for whichever half is showing, and the bell.
          An open task is a page pushed over the list: no header, just its own back row. */}
      {!showingTaskDetail && <MobileHeader
        segments={{
          items: [
            { id: "tasks", label: intl.formatMessage({ id: "mobile.board.tasks", defaultMessage: "Tasks" }) },
            { id: "channels", label: intl.formatMessage({ id: "mobile.channel.channels", defaultMessage: "Channels" }) },
          ],
          selected: section,
          onSelect: (id) => setSection(id === "channels" ? "channels" : "tasks"),
        }}
        menu={{
          label: intl.formatMessage({ id: "mobile.board.filter", defaultMessage: "Filter" }),
          // Filled while anything narrows the list, so a short list explains itself.
          icon: <ListFilter className={cn("size-[18px]", filtering && "text-foreground")} />,
          symbol: filtering ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle",
          nodes: menuNodes,
          onSelect: selectMenu,
        }}
        actions={[{
          id: "new",
          label: section === "tasks"
            ? intl.formatMessage({ id: "task.toolbar.newTask", defaultMessage: "New Task" })
            : intl.formatMessage({ id: "mobile.channel.newChannel", defaultMessage: "New channel" }),
          icon: <Plus className="size-[18px]" />,
          symbol: "plus",
          onClick: () => (section === "tasks" ? setNewTaskOpen(true) : void startCreating()),
        }]}
      />}

      {/* Lists scroll under a floating native bar (they pad their first row below
          it); an open task's back row only has the status bar to clear. */}
      <div
        className="min-h-0 flex-1"
        style={showingTaskDetail ? { paddingTop: topInset, paddingBottom: contentBottom } : undefined}
      >
        {section === "tasks" ? (
          <TasksPage
            projectFilter={projectFilter}
            onOpenWorkspace={openWorkspace}
            onOpenChat={onOpenChat}
            onOpenChannel={(channelId, messageId) => {
              setChannelFocus(messageId)
              setActiveChannel(channelId)
            }}
            initialTaskId={pendingTaskId}
            onInitialTaskConsumed={() => setPendingTaskId(null)}
            initialView="list"
            showNewTask={false}
            controls={controls}
            listTopOffset={contentOffset}
            listBottomOffset={contentBottom}
          />
        ) : groups.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center" style={{ paddingTop: contentOffset }}>
            <Hash className="size-6 text-muted-foreground/60" />
            <p className="text-base font-medium text-foreground/85">
              <FormattedMessage id="mobile.channel.emptyTitle" defaultMessage="No channels yet" />
            </p>
            <p className="text-[13px] text-muted-foreground/70">
              <FormattedMessage id="mobile.channel.emptyDesc" defaultMessage="Create one to start collaborating." />
            </p>
          </div>
        ) : (
          <div className="h-full overflow-y-auto p-2" style={{ paddingTop: `calc(${contentOffset} + 0.5rem)`, paddingBottom: `calc(${contentBottom} + 0.5rem)` }}>
            {groups.map(({ project, list }) => (
              <Fragment key={project.id}>
                {/* One project's list needs no heading: the bar above already names it. */}
                {projectFilter == null && (
                  <div className="px-3 pb-1 pt-3 text-[13px] font-medium text-muted-foreground/80 first:pt-1">{project.name}</div>
                )}
                {list.map((channel) => (
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
              </Fragment>
            ))}
          </div>
        )}
      </div>
      {createSheet}
    </div>
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
  projectId: number | null
  onBack: () => void
  onOpenWorkspace: (workspaceId: number) => void
}) {
  const intl = useIntl()
  const agents = useChannelStore((s) => s.agents)
  const topInset = useMobileTopInset()
  const contentBottom = useMobileContentBottom()
  const [detail, setDetail] = useState<Agent | null>(null)
  const [manage, setManage] = useState(false)

  return (
    <div className="flex h-full flex-col">
      {/* No bar above it any more: this row clears the status bar itself. */}
      <div className="shrink-0 border-b border-border/50" style={{ paddingTop: topInset }}>
      <div className="flex h-11 items-center gap-1 px-2">
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
          <div className="h-full overflow-y-auto p-2" style={{ paddingBottom: `calc(${contentBottom} + 0.5rem)` }}>
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
