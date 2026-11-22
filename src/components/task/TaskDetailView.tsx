import { TaskAssigneeAvatar } from './TaskExecutionIndicator'
import { useMemo, useState, useRef } from 'react'
import {
  ArrowLeft,
  Bot,
  ExternalLink,
  Tag,
  GitBranch,
  Check,
  Zap,
  Plus,
  Archive,
  ArchiveRestore,
  Send,
  Loader2,
  UserRound,
  CircleDot,
  Sparkles,
  Settings2,
  Hash,
  Ban,
  Eye,
  EyeOff,
} from 'lucide-react'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { GithubIcon } from '@/components/icons/GithubIcon'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { openExternalUrl } from '@/lib/open-external'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { GithubLinkProvider, type GithubLinkInfo } from '@/components/ai-elements/github-link-chip'
import { AgentAvatar } from '@/components/icons/AgentAvatar'
import { githubLinkKey } from '@/lib/github-links'
import { useIntl, FormattedMessage, type IntlShape } from 'react-intl'
import { useTaskStore } from '@/stores/task-store'
import { useScrollActivity } from '@/hooks/useScrollActivity'
import { useProjectStore } from '@/stores/project-store'
import { useChannelStore } from '@/stores/channel-store'
import { StatusIcon, PriorityIcon, LabelChip, TaskRef } from './task-meta'
import { SpecPanel } from '@/components/spec/SpecPanel'
import { STATUS_MESSAGES, ACTOR_MESSAGES, priorityMessage, activityEventMessage } from './task-i18n'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  isValidTaskTransition,
} from '@/types/task'
import type { TaskActivity, TaskAttachment, TaskDetail, TaskListItem, TaskPriority, TaskStatus, TaskSurface, UpdateTaskInput } from '@/types/task'
import { PendingImageStrip, TaskImageStrip, useImageUploads } from './task-attachments'
import { TaskWorkspaceLabel, TaskWorkspaceSelect, useWorkspaceName } from './TaskWorkspaceSelect'
import { SubtaskProposalCard, readProposal } from './SubtaskProposalCard'
import type { Agent, AgentSession } from '@/types/channel'
import type { LinearPublishOptions } from '@/types/integrations'
import { AgentManageDialog } from '@/components/channel/AgentManageDialog'
import { cn } from '@/lib/utils'
import { toastTaskError } from './task-error-toast'
import type { SpecChatRef } from '@shared/spec'
import { formatDateTime, formatRelativeTime } from '@/lib/format'

interface TaskDetailViewProps {
  detail: TaskDetail
  agents: Agent[]
  sessions: AgentSession[]
  onClose: () => void
  onOpenWorkspace?: (workspaceId: number) => void
  /** Opens a conversation the task links to (a spec's agents and tickets). */
  onOpenChat?: (chat: SpecChatRef) => void
  /** Jump to the channel (and message) the task was captured from. */
  onOpenChannel?: (channelId: number, messageId: number | null) => void
}

/**
 * Shared inline-input look for the inline "create" fields (new label /
 * sub-task). A thin transparent border that only firms up on focus — no chunky
 * gray focus ring (per the project's light-border UI guideline).
 */
const INLINE_INPUT =
  'h-7 text-sm bg-muted/30 rounded-md px-2.5 outline-none border border-transparent ' +
  'focus:border-border/60 focus:bg-muted/40 placeholder:text-muted-foreground/40 transition-colors'

/**
 * Every value in the properties column has this one shape: a full-width 32px
 * row whose text lines up with its label. Hover brightens the text and icons
 * instead of filling a box — any fill has a width, and with short values it
 * either leaves an empty slab beside the word (full width) or makes the rows
 * ragged (content width). Keyboard focus still gets the fill.
 */
const FIELD = 'group flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm text-foreground/85 transition-colors'
const FIELD_BUTTON =
  `${FIELD} cursor-pointer outline-none hover:text-foreground focus-visible:bg-row-hover ` +
  '[&_.text-muted-foreground]:transition-colors hover:[&_.text-muted-foreground]:text-foreground'
/** A Select trigger in that shape: no border, fill or shadow, and its chevron only on hover. */
const FIELD_TRIGGER =
  `${FIELD_BUTTON} justify-start border-transparent bg-transparent py-0 shadow-none hover:bg-transparent disabled:opacity-100 ` +
  '[&>svg:last-child]:ml-auto [&>svg:last-child]:opacity-0 [&>svg:last-child]:transition-opacity hover:[&>svg:last-child]:opacity-50 ' +
  'focus-visible:[&>svg:last-child]:opacity-50 data-[state=open]:[&>svg:last-child]:opacity-50'
/** The actions under the properties: the same rows, quieter until hovered. */
const ACTION_BUTTON = `${FIELD_BUTTON} text-muted-foreground`

/** What the assignee's session in the task worktree is doing, under the picker. */
const EXECUTION_STATUS_MESSAGES = {
  active: { id: 'task.detail.session.active', defaultMessage: 'Working' },
  idle: { id: 'task.detail.session.idle', defaultMessage: 'Session idle' },
  offline: { id: 'task.detail.session.offline', defaultMessage: 'Session offline' },
  completed: { id: 'task.detail.session.completed', defaultMessage: 'Session finished' },
} as const

/** Grow a textarea to its content (a no-op beside field-sizing, the fallback without it). */
function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

/** The assignee picker's last item: opens the agents instead of picking one. */
const MANAGE_AGENTS = '__manage_agents'

/**
 * The detail page while its task is on its way: the same back row and column,
 * with what the list already knows (key and title), so the page does not jump
 * when the rest arrives.
 */
export function TaskDetailPlaceholder({
  task,
  error,
  onClose,
}: {
  task?: TaskListItem
  error: string | null
  onClose: () => void
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="h-11 flex items-center gap-2 px-4 border-b border-border/40 shrink-0 bg-background">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground hover:text-foreground rounded-lg h-7 px-2.5"
          onClick={onClose}
        >
          <ArrowLeft className="h-4 w-4" />
          <FormattedMessage id="task.detail.back" defaultMessage="Tasks" />
        </Button>
        {task && <TaskRef projectId={task.projectId} number={task.number} className="text-xs text-muted-foreground/50" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6 md:py-5">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          {task && <h1 className="text-xl font-semibold leading-snug [overflow-wrap:anywhere]">{task.title}</h1>}
          {error ? (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <FormattedMessage id="task.detail.loadError" defaultMessage="Couldn't load this task: {error}" values={{ error }} />
            </div>
          ) : (
            <div role="status" className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              <FormattedMessage id="common.loading" defaultMessage="Loading…" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function TaskDetailView({
  detail,
  agents,
  onClose,
  onOpenWorkspace,
  onOpenChat,
  onOpenChannel,
}: TaskDetailViewProps) {
  const intl = useIntl()
  const sourceChannel = useChannelStore((s) =>
    detail.sourceChannelId != null ? s.channels.find((c) => c.id === detail.sourceChannelId) ?? null : null,
  )
  const update = useTaskStore((s) => s.update)
  const comment = useTaskStore((s) => s.comment)
  const dispatch = useTaskStore((s) => s.dispatch)
  const allTasks = useTaskStore((s) => s.tasks)
  const openDetail = useTaskStore((s) => s.openDetail)
  const parentTask = detail.parentTaskId != null ? allTasks.find((t) => t.id === detail.parentTaskId) : undefined
  const openBlockers = useMemo(
    () =>
      (detail.blockedBy ?? [])
        .map((id) => allTasks.find((t) => t.id === id))
        .filter((t): t is TaskListItem => t != null && t.status !== 'done' && t.status !== 'cancelled'),
    [detail.blockedBy, allTasks],
  )
  const setArchived = useTaskStore((s) => s.setArchived)
  const specHidden = useProjectStore((s) => s.hiddenSpecIds.includes(detail.id) ||
    (!s.shownSpecIds.includes(detail.id) && !s.projects.some((project) =>
      project.workspaces.some((workspace) => workspace.task?.id === detail.id),
    )))
  const setSpecHidden = useProjectStore((s) => s.setSpecHidden)


  // The scrollbars show only while scrolling: the pointer rests inside these
  // columns, so a hover-revealed bar would never go away.
  const pageScrollRef = useRef<HTMLDivElement>(null)
  const contentScrollRef = useRef<HTMLDivElement>(null)
  const propertiesScrollRef = useRef<HTMLDivElement>(null)
  useScrollActivity(pageScrollRef)
  useScrollActivity(contentScrollRef)
  useScrollActivity(propertiesScrollRef)
  const [dispatching, setDispatching] = useState(false)
  const workspaceName = useWorkspaceName(detail.workspaceId)
  // The Workspace row opens the workspace itself; a spec and its tickets have no such row.
  const hasWorkspaceRow = detail.specStage == null && detail.ticketState == null
  const [manageAgents, setManageAgents] = useState(false)
  const isArchived = detail.archivedAt != null
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(detail.title)
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState(detail.description)
  const [commentDraft, setCommentDraft] = useState('')
  const [sending, setSending] = useState(false)
  const commentImages = useImageUploads()
  // A description image is saved onto the task as soon as it is stored. The
  // store patches optimistically, so reading it back here sees the previous upload.
  const descImages = useImageUploads({
    onUploaded: (attachment) => {
      const current = useTaskStore.getState().detail
      const base = current?.id === detail.id ? current.attachments : detail.attachments
      updateDetail({ attachments: [...base, attachment] })
    },
  })

  const updateDetail = (updates: UpdateTaskInput) => {
    void update(detail.id, updates).catch((error) => toastTaskError(error, 'Task update failed'))
  }

  const saveTitle = () => {
    setEditingTitle(false)
    const next = titleDraft.trim()
    if (next && next !== detail.title) {
      updateDetail({ title: next })
    } else {
      setTitleDraft(detail.title)
    }
  }

  const saveDesc = () => {
    setEditingDesc(false)
    if (descDraft !== detail.description) {
      updateDetail({ description: descDraft })
    }
  }

  const sendComment = async () => {
    const body = commentDraft.trim()
    const attachments = commentImages.attachments
    if ((!body && attachments.length === 0) || commentImages.uploading) return
    setSending(true)
    try {
      await comment(detail.id, body, attachments)
      setCommentDraft('')
      commentImages.clear()
    } catch (error) {
      toastTaskError(error, 'Comment failed')
    } finally {
      setSending(false)
    }
  }

  const githubLinks = useMemo(() => githubLinkInfo(detail.surfaces, intl), [detail.surfaces, intl])

  const statusOptions = TASK_STATUSES.filter((s) => isValidTaskTransition(detail.status, s))
  const assigneeName = detail.assignedAgentId
    ? detail.assignedAgent?.name ?? agents.find((agent) => agent.id === detail.assignedAgentId)?.name ?? intl.formatMessage({ id: 'task.detail.unknownAgent', defaultMessage: 'Unknown' })
    : intl.formatMessage({ id: 'task.unassigned', defaultMessage: 'Unassigned' })


  return (
    // Phones stack the panels into one vertical scroll; md+ keeps the two-column
    // layout where each column scrolls independently.
    <GithubLinkProvider value={githubLinks}>
    <div ref={pageScrollRef} className="transcript-scrollbar flex flex-col md:flex-row h-full overflow-y-auto md:overflow-hidden">
      {/* Left: content */}
      <div className="flex flex-col min-w-0 md:flex-1 md:min-h-0">
        <div className="h-11 flex items-center gap-2 px-4 border-b border-border/40 shrink-0 sticky top-0 z-10 bg-background md:static">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-foreground rounded-lg h-7 px-2.5"
            onClick={onClose}
          >
            <ArrowLeft className="h-4 w-4" />
            <FormattedMessage id="task.detail.back" defaultMessage="Tasks" />
          </Button>
          {parentTask && (
            <>
              <button
                type="button"
                onClick={() => void openDetail(parentTask.id)}
                className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-row-hover hover:text-foreground"
              >
                <TaskRef projectId={parentTask.projectId} number={parentTask.number} />
                <span className="truncate max-w-48">{parentTask.title}</span>
              </button>
              <span className="text-xs text-muted-foreground/40">/</span>
            </>
          )}
          <TaskRef projectId={detail.projectId} number={detail.number} className="text-xs text-muted-foreground/50" />
          {sourceChannel && onOpenChannel && (
            <button
              type="button"
              onClick={() => onOpenChannel(sourceChannel.id, detail.sourceMessageId)}
              className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-row-hover hover:text-foreground"
              title={intl.formatMessage({ id: 'task.detail.openSourceChannel', defaultMessage: 'Open the message this task came from' })}
            >
              <Hash className="h-3 w-3 shrink-0" />
              <span className="truncate">{sourceChannel.name}</span>
            </button>
          )}
          {isArchived && (
            <span className="flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <Archive className="h-3 w-3" />
              <FormattedMessage id="task.detail.archivedBadge" defaultMessage="Archived" />
            </span>
          )}
        </div>

        <div ref={contentScrollRef} className="transcript-scrollbar min-w-0 md:flex-1 md:overflow-y-auto md:min-h-0 px-3 py-4 md:px-6 md:py-5">
          {/* Reading width, centered: the column keeps a text-friendly measure and splits leftover space evenly on wide windows. */}
          <div className="mx-auto w-full max-w-3xl space-y-6">
          {/* Title */}
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveTitle()
                if (e.key === 'Escape') {
                  setTitleDraft(detail.title)
                  setEditingTitle(false)
                }
              }}
              className="-mx-2 block w-[calc(100%+1rem)] text-xl font-semibold bg-transparent outline-none border-b border-border/50 px-2 pb-1"
            />
          ) : (
            <h1
              onClick={() => {
                setTitleDraft(detail.title)
                setEditingTitle(true)
              }}
              className="text-xl font-semibold leading-snug [overflow-wrap:anywhere] cursor-text hover:bg-row-hover rounded-lg px-2 -mx-2"
            >
              {detail.title}
            </h1>
          )}

          {/* Description */}
          <div>
            <div className="heading-section mb-1.5">
              <FormattedMessage id="task.detail.description" defaultMessage="Description" />
            </div>
            {editingDesc ? (
              <textarea
                autoFocus
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                onBlur={saveDesc}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setDescDraft(detail.description)
                    setEditingDesc(false)
                  }
                }}
                {...descImages.inputProps}
                placeholder={intl.formatMessage({ id: 'task.new.descriptionPlaceholder', defaultMessage: 'Add a description… (markdown supported, paste or drop images)' })}
                // Edits in place: same box and text as the read view, a faint fill
                // the only sign of editing, and it grows with the text instead of
                // scrolling inside a bordered box. The ref sizes it where
                // field-sizing is missing (older WebKit).
                ref={autoGrow}
                onInput={(e) => autoGrow(e.currentTarget)}
                className="-mx-2 block w-[calc(100%+1rem)] min-h-24 resize-none overflow-hidden rounded-lg border-0 bg-row-hover px-2 py-1.5 text-sm leading-relaxed text-foreground shadow-none outline-none field-sizing-content placeholder:text-muted-foreground/60 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
              />
            ) : (
              <div
                onClick={() => {
                  setDescDraft(detail.description)
                  setEditingDesc(true)
                }}
                onDrop={descImages.inputProps.onDrop}
                onDragOver={descImages.inputProps.onDragOver}
                className={cn(
                  'text-sm cursor-text rounded-lg transition-colors',
                  // Bleeds sideways only, so the text lines up with the heading
                  // and the hover fill never reaches up into it.
                  detail.description
                    ? 'text-foreground -mx-2 px-2 py-1.5 hover:bg-row-hover'
                    : 'min-h-10 border border-dashed border-border/50 px-3 py-2.5 hover:border-border/60 hover:bg-row-hover'
                )}
              >
                {detail.description ? (
                  <MarkdownRenderer content={detail.description} githubLinks />
                ) : (
                  <span className="text-muted-foreground/40"><FormattedMessage id="task.detail.addDescription" defaultMessage="Add a description…" /></span>
                )}
              </div>
            )}
            {(detail.attachments.length > 0 || descImages.items.length > 0) && (
              <div className={cn('flex flex-wrap items-start gap-2', 'mt-3')}>
                <TaskImageStrip
                  attachments={detail.attachments}
                  onRemove={(index) => updateDetail({ attachments: detail.attachments.filter((_, i) => i !== index) })}
                />
                <PendingImageStrip uploads={descImages} />
              </div>
            )}
          </div>

          {/* Sub-tasks (epic path) */}
          <SubtasksSection detail={detail} />

          {/* OperonSpec: design, tickets, review and both gates */}
          {detail.specStage != null && <SpecPanel taskId={detail.id} stage={detail.specStage} onOpenWorkspace={onOpenWorkspace} onOpenChat={onOpenChat} />}

          {/* Activity — timeline, oldest first, composer pinned at the end */}
          <div>
            <div className="heading-section mb-3">
              <FormattedMessage id="task.detail.activity" defaultMessage="Activity" />
            </div>
            <div className="relative">
              {/* Vertical rail; markers sit on top of it with a bg-background ring so it reads as one continuous line. */}
              <div aria-hidden className="absolute left-[11px] top-2 bottom-2 w-px bg-border/50 dark:bg-border/35" />
              <div className="space-y-1">
                {detail.activity.map((a) => (
                  <ActivityItem key={a.id} activity={a} taskId={detail.id} agents={agents} />
                ))}
              </div>
            </div>
          </div>

          {/* Comment composer */}
          <div className="flex flex-col gap-2">
            <textarea
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendComment()
              }}
              {...commentImages.inputProps}
              placeholder={
                detail.bindingId != null
                  ? intl.formatMessage({ id: 'task.detail.commentPlaceholderWake', defaultMessage: 'Leave a comment — wakes the agent… (⌘↵ to send)' })
                  : intl.formatMessage({ id: 'task.detail.commentPlaceholder', defaultMessage: 'Leave a comment… (⌘↵ to send)' })
              }
              aria-label={intl.formatMessage({ id: 'task.detail.comment', defaultMessage: 'Comment' })}
              className="w-full min-h-[72px] resize-none rounded-xl border-0 bg-muted/25 px-3.5 py-3 text-sm shadow-none outline-none transition-colors placeholder:text-muted-foreground/60 focus:bg-muted/40 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
            />
            <PendingImageStrip uploads={commentImages} />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                className="h-8"
                disabled={sending || commentImages.uploading || (!commentDraft.trim() && commentImages.attachments.length === 0)}
                onClick={() => void sendComment()}
              >
                <FormattedMessage id="task.detail.comment" defaultMessage="Comment" />
              </Button>
            </div>
          </div>
          </div>
        </div>
      </div>

      {/* Right: properties — sidebar at md+, full-width section below on phones */}
      <div ref={propertiesScrollRef} className="transcript-scrollbar w-full md:w-60 shrink-0 border-border/40 border-t md:border-t-0 md:border-l md:overflow-y-auto">
        <div className="p-4 space-y-5">
          <PropertyRow label={intl.formatMessage({ id: 'task.detail.statusLabel', defaultMessage: 'Status' })}>
            <Select
              value={detail.status}
              onValueChange={(v) => updateDetail({ status: v as TaskStatus })}
            >
              <SelectTrigger size="sm" className={FIELD_TRIGGER}>
                <span className="flex items-center gap-2">
                  <StatusIcon status={detail.status} />
                  <span className="text-sm">{intl.formatMessage(STATUS_MESSAGES[detail.status])}</span>
                </span>
              </SelectTrigger>
              <SelectContent position="popper" align="start" sideOffset={6}>
                {statusOptions.map((s) => (
                  <SelectItem key={s} value={s}>
                    <span className="flex items-center gap-2">
                      <StatusIcon status={s} />
                      {intl.formatMessage(STATUS_MESSAGES[s])}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropertyRow>

          <PropertyRow label={intl.formatMessage({ id: 'task.detail.priorityLabel', defaultMessage: 'Priority' })}>
            <Select
              value={String(detail.priority)}
              onValueChange={(v) => updateDetail({ priority: Number(v) as TaskPriority })}
            >
              <SelectTrigger size="sm" className={FIELD_TRIGGER}>
                <span className="flex items-center gap-2">
                  <PriorityIcon priority={detail.priority} />
                  <span className="text-sm">{intl.formatMessage(priorityMessage(detail.priority))}</span>
                </span>
              </SelectTrigger>
              <SelectContent position="popper" align="start" sideOffset={6}>
                {TASK_PRIORITIES.map((p) => (
                  <SelectItem key={p} value={String(p)}>
                    <span className="flex items-center gap-2">
                      <PriorityIcon priority={p} />
                      {intl.formatMessage(priorityMessage(p))}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropertyRow>

          <PropertyRow label={intl.formatMessage({ id: 'task.detail.assigneeLabel', defaultMessage: 'Assignee' })}>
            <Select
              disabled={detail.specStage != null}
              value={detail.assignedAgentId ? String(detail.assignedAgentId) : 'unassigned'}
              onValueChange={(v) => {
                // The last item is a way to the agents, not one of them.
                if (v === MANAGE_AGENTS) return setManageAgents(true)
                updateDetail({
                  assignedAgentId: v === 'unassigned' ? null : Number(v),
                })
              }}
            >
              <SelectTrigger size="sm" className={cn(FIELD_TRIGGER, 'max-w-full')}>
                <span className="flex min-w-0 items-center gap-2 overflow-hidden">
                  <TaskAssigneeAvatar task={detail} agents={agents} />
                  <span className="min-w-0 truncate text-sm" title={assigneeName}>
                    {assigneeName}
                  </span>
                </span>
              </SelectTrigger>
              <SelectContent position="popper" align="start" sideOffset={6}>
                <SelectItem value="unassigned"><FormattedMessage id="task.unassigned" defaultMessage="Unassigned" /></SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name}
                  </SelectItem>
                ))}
                <SelectSeparator />
                <SelectItem value={MANAGE_AGENTS} className="text-muted-foreground">
                  <Settings2 className="h-3.5 w-3.5" />
                  <FormattedMessage id="task.detail.manageAgents" defaultMessage="Manage agents…" />
                </SelectItem>
              </SelectContent>
            </Select>
            {manageAgents && <AgentManageDialog open onClose={() => setManageAgents(false)} />}
            {/* The agent's session in the task worktree (not a channel session of
                the same agent). Absent until dispatched. */}
            {detail.specStage == null && detail.assignedAgentId && detail.executionStatus && (
              <div className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    detail.executionStatus === 'active' && 'bg-status-info animate-pulse',
                    detail.executionStatus === 'idle' && 'bg-accent-green',
                    detail.executionStatus === 'offline' && 'bg-muted-foreground/40',
                  )}
                />
                {intl.formatMessage(EXECUTION_STATUS_MESSAGES[detail.executionStatus])}
              </div>
            )}
          </PropertyRow>

          {/* Where it runs — a spec and its tickets always get worktrees of their own. */}
          {hasWorkspaceRow && (
            <PropertyRow label={intl.formatMessage({ id: 'task.workspace.label', defaultMessage: 'Workspace' })}>
              {/* Chosen before it runs: once dispatched it is a fact about the task, not a choice. */}
              {detail.bindingId != null || isArchived ? (
                <TaskWorkspaceLabel
                  mode={detail.workspaceMode}
                  workspaceName={workspaceName}
                  className={detail.workspaceId && onOpenWorkspace ? FIELD_BUTTON : FIELD}
                  onOpen={detail.workspaceId && onOpenWorkspace ? () => onOpenWorkspace(detail.workspaceId!) : undefined}
                />
              ) : (
                <TaskWorkspaceSelect
                  className={FIELD_TRIGGER}
                  value={detail.workspaceMode}
                  onChange={(workspaceMode) => updateDetail({ workspaceMode })}
                />
              )}
            </PropertyRow>
          )}

          <RelationRows detail={detail} />

          <PropertyRow label={intl.formatMessage({ id: 'task.detail.labelsLabel', defaultMessage: 'Labels' })}>
            <LabelPicker detail={detail} />
          </PropertyRow>

          <PropertyRow label={intl.formatMessage({ id: 'task.surfaces.label', defaultMessage: 'Linear' })}>
            <SurfacesBlock detail={detail} />
          </PropertyRow>

          {detail.surfaces.some((s) => s.kind === 'github_pr') && (
            <PropertyRow label={intl.formatMessage({ id: 'task.surfaces.githubLabel', defaultMessage: 'GitHub' })}>
              <div className="space-y-0.5">
                {detail.surfaces
                  .filter((s) => s.kind === 'github_pr')
                  .map((s) => (
                    <SurfaceRow key={s.id} surface={s} />
                  ))}
              </div>
            </PropertyRow>
          )}

          {detail.branchName && (
            <PropertyRow label={intl.formatMessage({ id: 'task.detail.branchLabel', defaultMessage: 'Branch' })}>
              <div className={cn(FIELD, 'font-mono text-xs')} title={detail.branchName}>
                <GitBranch className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{detail.branchName}</span>
              </div>
            </PropertyRow>
          )}

          {/* Actions: the one that starts work leads as the filled button; the
              rest sit under it, left-aligned like the rows above. */}
          <div className="space-y-1 border-t border-border/40 pt-4">
          {/* Dispatch — start (or restart) the assigned agent in the task worktree.
              Shown whenever the task is assigned and has no live execution session,
              regardless of status — so a task that reached in_progress without ever
              being dispatched (e.g. an agent flipped it via update_project_task) isn't stuck
              with no way to launch the executor. A spec parent is never dispatched
              itself: its tickets are the work. */}
          {detail.assignedAgentId &&
            detail.specStage == null &&
            detail.executionStatus !== 'active' &&
            detail.executionStatus !== 'idle' && (
              <Button
                size="sm"
                variant="secondary"
                className="h-8 w-full gap-1.5"
                disabled={dispatching || openBlockers.length > 0}
                onClick={async () => {
                  if (detail.assignedAgentId == null) return
                  setDispatching(true)
                  try {
                    await dispatch(detail.id, detail.assignedAgentId)
                  } catch (error) {
                    toastTaskError(error, 'Dispatch failed')
                  } finally {
                    setDispatching(false)
                  }
                }}
              >
                {dispatching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                {dispatching
                  ? intl.formatMessage({ id: 'task.detail.dispatching', defaultMessage: 'Dispatching…' })
                  : detail.bindingId != null
                    ? intl.formatMessage({ id: 'task.detail.redispatch', defaultMessage: 'Re-dispatch' })
                    : intl.formatMessage({ id: 'task.detail.dispatch', defaultMessage: 'Dispatch' })}
              </Button>
            )}

          {openBlockers.length > 0 && detail.executionStatus !== 'active' && detail.executionStatus !== 'idle' && (
            <p className="px-2 pb-1 text-xs text-muted-foreground">
              <FormattedMessage
                id="task.detail.waitingOnBlockers"
                defaultMessage="Starts once {tasks} {count, plural, one {is} other {are}} done."
                values={{ tasks: openBlockers.map((b) => `#${b.number}`).join(', '), count: openBlockers.length }}
              />
            </p>
          )}

          {!hasWorkspaceRow && detail.workspaceId && onOpenWorkspace && (
            <button type="button" className={ACTION_BUTTON} onClick={() => onOpenWorkspace(detail.workspaceId!)}>
              <ExternalLink className="h-3.5 w-3.5" />
              <FormattedMessage id="task.detail.openWorkspace" defaultMessage="Open Workspace" />
            </button>
          )}

          {detail.specStage != null && !isArchived && (
            <button type="button" className={ACTION_BUTTON} onClick={() => setSpecHidden(detail.id, !specHidden)}>
              {specHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              {specHidden ? 'Show in sidebar' : 'Hide from sidebar'}
            </button>
          )}

          {/* Archive — retire the task from the board (or restore it). */}
          <button
            type="button"
            className={ACTION_BUTTON}
            onClick={() => {
              void setArchived(detail.id, !isArchived).catch((error) =>
                toastTaskError(error, isArchived ? 'Unarchive failed' : 'Archive failed'),
              )
            }}
          >
            {isArchived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
            {isArchived ? (
              <FormattedMessage id="task.detail.unarchive" defaultMessage="Unarchive" />
            ) : (
              <FormattedMessage id="task.detail.archive" defaultMessage="Archive" />
            )}
          </button>
          </div>
        </div>
      </div>
    </div>
    </GithubLinkProvider>
  )
}

/** The siblings a sub-task still waits for, in the parent's list. Nothing once they are done. */
function WaitingOn({ task, siblings }: { task: TaskListItem; siblings: TaskListItem[] }) {
  const intl = useIntl()
  if (task.status === 'done' || task.status === 'cancelled') return null
  const open = (task.blockedBy ?? [])
    .map((id) => siblings.find((s) => s.id === id))
    .filter((s): s is TaskListItem => s != null && s.status !== 'done' && s.status !== 'cancelled')
  if (open.length === 0) return null
  const label = intl.formatMessage(
    { id: 'task.card.blockedBy', defaultMessage: 'Blocked by {tasks}' },
    { tasks: open.map((b) => `#${b.number}`).join(', ') },
  )
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-status-warn tabular-nums" title={label}>
      <Ban className="w-3 h-3" aria-hidden />
      <span aria-hidden>{open.map((b) => `#${b.number}`).join(' ')}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** Where this task sits: the task it belongs to and the ones it waits for. */
function RelationRows({ detail }: { detail: TaskDetail }) {
  const intl = useIntl()
  const tasks = useTaskStore((s) => s.tasks)
  const openDetail = useTaskStore((s) => s.openDetail)
  const parent = detail.parentTaskId != null ? tasks.find((t) => t.id === detail.parentTaskId) : undefined
  const blockers = (detail.blockedBy ?? [])
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is TaskListItem => t != null)
  const blocking = tasks.filter((t) => t.blockedBy?.includes(detail.id))
  const row = (t: TaskListItem) => (
    <button
      key={t.id}
      onClick={() => void openDetail(t.id)}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-row-hover text-left transition-colors"
    >
      <StatusIcon status={t.status} />
      <span className="text-xs text-muted-foreground/50 tabular-nums">#{t.number}</span>
      <span className="flex-1 text-sm truncate text-foreground/90">{t.title}</span>
    </button>
  )
  return (
    <>
      {parent && (
        <PropertyRow label={intl.formatMessage({ id: 'task.detail.parentLabel', defaultMessage: 'Parent' })}>
          {row(parent)}
        </PropertyRow>
      )}
      {blockers.length > 0 && (
        <PropertyRow label={intl.formatMessage({ id: 'task.detail.blockedByLabel', defaultMessage: 'Blocked by' })}>
          <div className="space-y-0.5">{blockers.map(row)}</div>
        </PropertyRow>
      )}
      {blocking.length > 0 && (
        <PropertyRow label={intl.formatMessage({ id: 'task.detail.blockingLabel', defaultMessage: 'Blocking' })}>
          <div className="space-y-0.5">{blocking.map(row)}</div>
        </PropertyRow>
      )}
    </>
  )
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="heading-section px-2">
        {label}
      </div>
      {children}
    </div>
  )
}

function LabelPicker({ detail }: { detail: TaskDetail }) {
  const intl = useIntl()
  // The store holds every project's labels on the global board; a task takes its own project's.
  const allLabels = useTaskStore((s) => s.labels)
  const labels = useMemo(() => allLabels.filter((l) => l.projectId === detail.projectId), [allLabels, detail.projectId])
  const update = useTaskStore((s) => s.update)
  const createLabel = useTaskStore((s) => s.createLabel)
  const selected = new Set(detail.labels.map((l) => l.id))
  const [newName, setNewName] = useState('')

  const toggle = (labelId: number) => {
    const next = new Set(selected)
    if (next.has(labelId)) next.delete(labelId)
    else next.add(labelId)
    void update(detail.id, { labelIds: Array.from(next) }).catch((error) =>
      toastTaskError(error, 'Task update failed'),
    )
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      const label = await createLabel({ projectId: detail.projectId, name })
      setNewName('')
      // Auto-apply the freshly created label to this task.
      await update(detail.id, { labelIds: [...Array.from(selected), label.id] })
    } catch (error) {
      toastTaskError(error, 'Label update failed')
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={cn(FIELD_BUTTON, 'h-auto min-h-8 flex-wrap gap-1 py-1')}>
          {detail.labels.length > 0 ? (
            detail.labels.map((l) => <LabelChip key={l.id} label={l} />)
          ) : (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Tag className="w-3.5 h-3.5" />
              <FormattedMessage id="task.detail.addLabels" defaultMessage="Add labels" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-60 p-0 overflow-hidden rounded-lg border border-border/50 bg-popover/95 backdrop-blur-sm shadow-float"
      >
        {labels.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground/40 text-center"><FormattedMessage id="task.detail.noLabels" defaultMessage="No labels yet" /></p>
        ) : (
          <div className="max-h-52 overflow-y-auto p-1">
            {labels.map((l) => (
              <button
                key={l.id}
                onClick={() => toggle(l.id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-row-hover text-sm transition-colors"
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
                <span className="flex-1 text-left truncate">{l.name}</span>
                {selected.has(l.id) && <Check className="w-3.5 h-3.5 text-primary" />}
              </button>
            ))}
          </div>
        )}

        {/* Create a new label inline */}
        <div className="flex items-center gap-1.5 border-t border-border/40 p-1.5">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate()
            }}
            placeholder={intl.formatMessage({ id: 'task.detail.newLabelPlaceholder', defaultMessage: 'New label…' })}
            className={cn(INLINE_INPUT, 'flex-1 min-w-0')}
          />
          <Button
            size="sm"
            variant="secondary"
            className="h-7 px-2.5 text-xs shrink-0"
            disabled={!newName.trim()}
            onClick={() => void handleCreate()}
          >
            <FormattedMessage id="common.add" defaultMessage="Add" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function SubtasksSection({ detail }: { detail: TaskDetail }) {
  const intl = useIntl()
  const createSubtask = useTaskStore((s) => s.createSubtask)
  const openDetail = useTaskStore((s) => s.openDetail)
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const children = detail.children
  const done = children.filter((c) => c.status === 'done').length

  const add = async () => {
    const t = title.trim()
    if (!t || saving) return
    setSaving(true)
    try {
      await createSubtask(detail.id, t)
      setTitle('')
    } catch (error) {
      toastTaskError(error, 'Sub-task failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="heading-section">
          <FormattedMessage id="task.detail.subtasks" defaultMessage="Sub-tasks" />
          {children.length > 0 && (
            <span className="ml-1.5 text-muted-foreground/40 tabular-nums">
              {done}/{children.length}
            </span>
          )}
        </div>
        <button
          onClick={() => setAdding((v) => !v)}
          aria-label={intl.formatMessage({ id: 'task.detail.addSubtaskButton', defaultMessage: 'Add sub-task' })}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent-hover hover:text-foreground"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="space-y-0.5">
        {children.map((c) => (
          <button
            key={c.id}
            onClick={() => void openDetail(c.id)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-row-hover text-left transition-colors"
          >
            <StatusIcon status={c.status} />
            <span className="text-xs text-muted-foreground/50 tabular-nums">#{c.number}</span>
            <span className="flex-1 text-sm truncate text-foreground/90">{c.title}</span>
            <WaitingOn task={c} siblings={children} />
          </button>
        ))}
        {adding && (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add()
              if (e.key === 'Escape') {
                setAdding(false)
                setTitle('')
              }
            }}
            onBlur={() => {
              if (!title.trim()) setAdding(false)
            }}
            placeholder={intl.formatMessage({ id: 'task.detail.subtaskPlaceholder', defaultMessage: 'Sub-task title…' })}
            className={cn(INLINE_INPUT, 'w-full')}
          />
        )}
        {children.length === 0 && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="w-full text-left text-xs text-muted-foreground/50 rounded-lg border border-dashed border-border/50 px-3 py-2 hover:border-border/60 hover:bg-row-hover hover:text-muted-foreground transition-colors"
          >
            <FormattedMessage id="task.detail.addSubtask" defaultMessage="+ Add sub-task" />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Where else this task is visible (docs/linear-github/design.md §13): the
 * Linear issue, the agent session on it, the pull request. Tasks without a
 * Linear issue can be published from here.
 */
function SurfacesBlock({ detail }: { detail: TaskDetail }) {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<LinearPublishOptions | null>(null)
  const [loading, setLoading] = useState(false)
  const [publishing, setPublishing] = useState<string | null>(null)
  const hasIssue = detail.surfaces.some((s) => s.kind === 'linear_issue')

  // The team is chosen at publish time (there is no project ↔ team binding);
  // the one used last for this project is marked as the suggestion.
  const load = async () => {
    setLoading(true)
    try {
      setOptions(await api.integrationLinearPublishOptions(detail.projectId))
    } catch (error) {
      toastTaskError(error, 'Could not load Linear teams')
      setOpen(false)
    } finally {
      setLoading(false)
    }
  }

  const publish = async (teamId: string) => {
    setPublishing(teamId)
    try {
      const res = await api.integrationLinearPublishTask({ taskId: detail.id, teamId })
      const url = res.issue.url
      const subtasks = res.issue.subtasks ?? { published: 0, failed: 0 }
      toast.success(
        <span className="flex items-center gap-2">
          {subtasks.published > 0 ? (
            <FormattedMessage
              id="task.surfaces.publishedWithSubtasks"
              defaultMessage="Published to Linear as {identifier} with {count, plural, one {# sub-issue} other {# sub-issues}}"
              values={{ identifier: res.issue.identifier, count: subtasks.published }}
            />
          ) : (
            <FormattedMessage
              id="task.surfaces.published"
              defaultMessage="Published to Linear as {identifier}"
              values={{ identifier: res.issue.identifier }}
            />
          )}
          {url && (
            <button type="button" className="underline" onClick={() => openExternalUrl(url)}>
              <FormattedMessage id="task.surfaces.open" defaultMessage="Open" />
            </button>
          )}
        </span>,
      )
      if (subtasks.failed > 0) {
        toast.warning(
          intl.formatMessage(
            {
              id: 'task.surfaces.subtasksFailed',
              defaultMessage: '{count, plural, one {# subtask} other {# subtasks}} could not be published; they will be retried later.',
            },
            { count: subtasks.failed },
          ),
        )
      }
      setOpen(false)
    } catch (error) {
      toastTaskError(error, 'Publish to Linear failed')
    } finally {
      setPublishing(null)
    }
  }

  // One row: the issue. The agent session lives on that same Linear page, so
  // it gets no row of its own; pull requests have their own block.
  return (
    <div className="space-y-0.5">
      {detail.surfaces
        .filter((s) => s.kind === 'linear_issue')
        .map((s) => (
          <SurfaceRow key={s.id} surface={s} />
        ))}
      {!hasIssue && (
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            if (next && !options) void load()
          }}
        >
          <PopoverTrigger asChild>
            <button type="button" className={cn(FIELD_BUTTON, 'text-muted-foreground hover:text-foreground')}>
              <LinearIcon className="w-3.5 h-3.5 shrink-0" />
              <FormattedMessage id="task.surfaces.publish" defaultMessage="Publish to Linear" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={6}
            className="w-60 p-0 overflow-hidden rounded-lg border border-border/50 bg-popover/95 backdrop-blur-sm shadow-float"
          >
            <div className="px-2 pt-2 pb-1 text-[11px] text-muted-foreground">
              <FormattedMessage id="task.surfaces.pickTeam" defaultMessage="Publish to which Linear team?" />
            </div>
            <div className="max-h-52 overflow-y-auto p-1">
              {loading && (
                <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <FormattedMessage id="common.loading" defaultMessage="Loading…" />
                </div>
              )}
              {!loading && options?.teams.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  <FormattedMessage id="task.surfaces.noTeams" defaultMessage="No teams in this workspace." />
                </div>
              )}
              {options?.teams.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  disabled={publishing !== null}
                  onClick={() => void publish(t.id)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary-hover text-sm transition-colors disabled:opacity-60"
                >
                  <span className="font-mono text-[11px] text-muted-foreground w-10 shrink-0 text-left">{t.key}</span>
                  <span className="flex-1 text-left truncate">{t.name}</span>
                  {publishing === t.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : (
                    options.defaultTeamId === t.id && <Check className="w-3.5 h-3.5 text-primary" />
                  )}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

/** The word SurfaceRow puts after a PR: nothing while open, `merged` / `closed` after. */
function pullRequestStateLabel(meta: Record<string, unknown>, intl: IntlShape): string | null {
  return meta.merged
    ? intl.formatMessage({ id: 'task.surfaces.state.merged', defaultMessage: 'merged' })
    : meta.state === 'closed'
      ? intl.formatMessage({ id: 'task.surfaces.state.closed', defaultMessage: 'closed' })
      : null
}

/** The task's PRs, for the GitHub chips in its description and comments. */
function githubLinkInfo(surfaces: TaskSurface[], intl: IntlShape): GithubLinkInfo {
  const states: Record<string, string> = {}
  let repo: string | undefined
  for (const s of surfaces) {
    if (s.kind !== 'github_pr') continue
    const key = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(s.externalId)
    if (!key) continue
    repo ??= `${key[1]}/${key[2]}`
    const state = pullRequestStateLabel(s.meta ?? {}, intl)
    if (state) states[githubLinkKey(key[1], key[2], Number(key[3]))] = state
  }
  return { repo, states }
}

function SurfaceRow({ surface: s }: { surface: TaskSurface }) {
  const intl = useIntl()
  const meta = s.meta ?? {}
  let label: string
  let state: string | null = null
  if (s.kind === 'linear_issue') {
    label = String(meta.identifier ?? intl.formatMessage({ id: 'task.surfaces.linearIssue', defaultMessage: 'Linear issue' }))
  } else if (s.kind === 'linear_session') {
    return null
  } else {
    const n = meta.number ?? s.externalId.split('#')[1]
    label = `PR #${String(n ?? '')}`
    // Open is the normal case and says nothing; only merged / closed is worth a word.
    state = pullRequestStateLabel(meta, intl)
  }
  // Same shape as the Linear row: label, then the link icon right next to it.
  const Brand = s.kind === 'github_pr' ? GithubIcon : LinearIcon
  const inner = (
    <>
      <Brand className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
      {state && <span className="text-muted-foreground shrink-0">· {state}</span>}
      {s.url && <ExternalLink className="w-3 h-3 shrink-0 text-muted-foreground" />}
    </>
  )
  if (s.url) {
    const url = s.url
    return (
      <button type="button" className={FIELD_BUTTON} onClick={() => openExternalUrl(url)}>
        {inner}
      </button>
    )
  }
  return <div className={FIELD}>{inner}</div>
}

/**
 * Compact markdown for comment bodies. A comment is a reply inside a
 * thread, not a document: headings step down one more notch than chat and
 * vertical rhythm is tightened so an agent reply doesn't fill a screen.
 */
const COMMENT_MARKDOWN_CLASS =
  'prose-h1:text-base prose-h2:text-sm prose-h3:text-sm prose-h4:text-sm ' +
  'prose-headings:mt-3 prose-headings:mb-1 prose-p:my-1 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 ' +
  'prose-code:text-[12px] prose-pre:my-2'

/** Images a person pasted into a comment (meta.attachments, written by the server). */
function commentAttachments(a: TaskActivity): TaskAttachment[] {
  const raw = a.meta?.attachments
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is TaskAttachment =>
    !!x && typeof x === 'object' && typeof (x as TaskAttachment).url === 'string' && typeof (x as TaskAttachment).mediaType === 'string')
}

function actorLabel(a: TaskActivity, intl: IntlShape): string {
  if (a.actorType === 'system') return intl.formatMessage(ACTOR_MESSAGES.system)
  if (a.actorName === 'You') return intl.formatMessage(ACTOR_MESSAGES.You)
  if (a.actorName === 'human') return intl.formatMessage(ACTOR_MESSAGES.human)
  return a.actorName
}

function ActorIcon({ activity: a }: { activity: TaskActivity }) {
  const cls = 'w-3 h-3'
  if (a.actorType === 'agent') return <Bot className={cls} />
  if (a.actorType === 'human') return <UserRound className={cls} />
  return <Sparkles className={cls} />
}

function EventIcon({ activity: a }: { activity: TaskActivity }) {
  const cls = 'w-3 h-3'
  switch (a.kind) {
    case 'status':
      return <CircleDot className={cls} />
    case 'assign':
      return <UserRound className={cls} />
    case 'dispatch':
      return <Zap className={cls} />
    case 'branch':
      return <GitBranch className={cls} />
    default:
      return <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
  }
}

/** Marker that sits on the timeline rail: ringed with the page background so the rail appears to pass behind it. */
function TimelineMarker({ children, emphasis }: { children: React.ReactNode; emphasis?: boolean }) {
  return (
    <span
      className={cn(
        'relative z-[1] flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-4 ring-background',
        emphasis
          ? 'bg-muted text-foreground/80 dark:bg-muted'
          : 'bg-background text-muted-foreground/70 border border-border/50 dark:border-border/35',
      )}
    >
      {children}
    </span>
  )
}

function ActivityItem({ activity: a, taskId, agents }: { activity: TaskActivity; taskId: number; agents: Agent[] }) {
  const intl = useIntl()
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)
  const absoluteTime = formatDateTime(a.createdAt)
  const proposal = readProposal(a)
  if (proposal) return <SubtaskProposalCard activity={a} proposal={proposal} taskId={taskId} agents={agents} />
  if (a.kind === 'comment') {
    const meta = a.meta ?? {}
    const source = meta.source === 'github_pr' ? 'GitHub' : meta.source ? 'Linear' : null
    const forwardable = meta.actor === 'other' && meta.sent !== true
    // An agent's comment wears its avatar, as it does on the assignee picker.
    const commentAgent = a.actorType === 'agent' && a.actorId != null ? agents.find((x) => x.id === a.actorId) : undefined
    const sendToAgent = async () => {
      setSending(true)
      try {
        await api.taskSendActivityToAgent(taskId, a.id)
        setSent(true)
      } catch (error) {
        toastTaskError(error, 'Send to agent failed')
      } finally {
        setSending(false)
      }
    }
    return (
      // No card: the rail and the avatar already set each comment apart, and a
      // border + fill + shadow + header rule around every one turned the feed
      // into a stack of boxes. Name, source and time head the body, which sits
      // under the name.
      <div className="flex items-start gap-3 py-2.5">
        {commentAgent ? (
          <AgentAvatar provider={commentAgent.provider} size="sm" className="relative z-[1] ring-4 ring-background" />
        ) : (
          <TimelineMarker emphasis>
            <ActorIcon activity={a} />
          </TimelineMarker>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex h-6 items-center gap-2 text-xs">
            <span className="font-medium text-foreground/90">{actorLabel(a, intl)}</span>
            {source && (
              <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {source}
              </span>
            )}
            <span className="text-muted-foreground/60 tabular-nums" title={absoluteTime}>{formatRelativeTime(intl, a.createdAt, { compact: true })}</span>
            {forwardable && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 gap-1 px-2 text-[11px]"
                disabled={sending || sent}
                onClick={() => void sendToAgent()}
              >
                <Send className="w-3 h-3" />
                {sent
                  ? <FormattedMessage id="task.activity.sent" defaultMessage="Sent" />
                  : <FormattedMessage id="task.activity.sendToAgent" defaultMessage="Send to agent" />}
              </Button>
            )}
          </div>
          <div className="mt-0.5 text-sm text-foreground/90">
            {a.body.trim() && <MarkdownRenderer content={a.body} className={COMMENT_MARKDOWN_CLASS} githubLinks />}
            <TaskImageStrip attachments={commentAttachments(a)} className={a.body.trim() ? 'mt-2' : undefined} />
          </div>
        </div>
      </div>
    )
  }

  const prUrl = pullRequestUrlOf(a)
  return (
    <div className="flex items-center gap-3 py-1 text-xs">
      <TimelineMarker>
        {prUrl ? <GithubIcon className="w-3 h-3" /> : <EventIcon activity={a} />}
      </TimelineMarker>
      <div className="min-w-0 flex-1 flex items-baseline gap-1.5">
        <span className="font-medium text-foreground/85 shrink-0">{actorLabel(a, intl)}</span>
        {prUrl ? (
          <button
            type="button"
            onClick={() => openExternalUrl(prUrl)}
            className="inline-flex min-w-0 items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
          >
            <span className="truncate">{describeEvent(a, intl)}</span>
            <ExternalLink className="w-3 h-3 shrink-0" />
          </button>
        ) : (
          <span className="text-muted-foreground truncate">{describeEvent(a, intl)}</span>
        )}
      </div>
      <span className="shrink-0 text-muted-foreground/60 tabular-nums" title={absoluteTime}>
        {formatRelativeTime(intl, a.createdAt, { compact: true })}
      </span>
    </div>
  )
}

/**
 * A pull-request event row (opened / pushed / closed / …) links to its PR: the
 * opened row stores the URL, the others the PR key `owner/name#number`.
 */
function pullRequestUrlOf(a: TaskActivity): string | null {
  const meta = a.meta
  if (a.kind !== 'system' || meta?.source !== 'github_pr') return null
  if (typeof meta.url === 'string' && /^https:\/\//.test(meta.url)) return meta.url
  const key = typeof meta.pr === 'string' ? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(meta.pr) : null
  return key ? `https://github.com/${key[1]}/pull/${key[2]}` : null
}

function describeEvent(a: TaskActivity, intl: IntlShape): string {
  const meta = a.meta ?? {}
  // Translate a raw status string (from event meta) to its localized label.
  const statusLabel = (s: unknown): string => {
    const key = String(s ?? '')
    return key in STATUS_MESSAGES
      ? intl.formatMessage(STATUS_MESSAGES[key as TaskStatus])
      : key
  }
  switch (a.kind) {
    case 'status':
      return intl.formatMessage(
        { id: 'task.activity.status', defaultMessage: 'changed status {from} → {to}' },
        { from: statusLabel(meta.from), to: statusLabel(meta.to) },
      )
    case 'assign':
      return meta.to
        ? intl.formatMessage({ id: 'task.activity.assigned', defaultMessage: 'assigned the task' })
        : intl.formatMessage({ id: 'task.activity.unassigned', defaultMessage: 'unassigned the task' })
    case 'dispatch':
      return intl.formatMessage({ id: 'task.activity.dispatched', defaultMessage: 'dispatched the task' })
    case 'branch':
      return intl.formatMessage(
        { id: 'task.activity.branch', defaultMessage: 'created branch {branch}' },
        { branch: String(meta.branch ?? '') },
      )
    case 'system': {
      // Structured events carry a code + params next to the English body;
      // render those through i18n and fall back to the body otherwise.
      const message = activityEventMessage(meta.event)
      if (message) {
        const values: Record<string, string | number> = {}
        for (const [k, v] of Object.entries(meta)) {
          if (typeof v === 'string' || typeof v === 'number') values[k] = v
        }
        if (meta.event === 'subtask.status') values.to = statusLabel(meta.to)
        return intl.formatMessage(message, values)
      }
      return a.body || intl.formatMessage({ id: 'task.activity.updated', defaultMessage: 'updated the task' })
    }
    default:
      return a.body
  }
}
