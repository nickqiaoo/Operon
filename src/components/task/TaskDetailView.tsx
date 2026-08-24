import { useState } from 'react'
import {
  ArrowLeft,
  Bot,
  ExternalLink,
  Tag,
  GitBranch,
  Check,
  Zap,
  Users,
  Plus,
  Archive,
  ArchiveRestore,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { useIntl, FormattedMessage, type IntlShape } from 'react-intl'
import { useTaskStore } from '@/stores/task-store'
import { StatusIcon, PriorityIcon, LabelChip, AssigneeAvatar, relativeTime } from './task-meta'
import { SddArtifactsPanel } from './SddArtifactsPanel'
import { STATUS_MESSAGES, priorityMessage } from './task-i18n'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  isValidTaskTransition,
} from '@/types/task'
import type { TaskActivity, TaskDetail, TaskPriority, TaskStatus, PreparedSubtask, UpdateTaskInput } from '@/types/task'
import type { Agent, AgentSession } from '@/types/channel'
import { DispatchDialog } from './DispatchDialog'
import { VerifyDialog } from './VerifyDialog'
import { cn } from '@/lib/utils'
import { toastTaskError } from './task-error-toast'
import { splitPlanTaskText } from '@shared/taskboard/plan-task'

interface TaskDetailViewProps {
  detail: TaskDetail
  agents: Agent[]
  sessions: AgentSession[]
  onClose: () => void
  onOpenWorkspace?: (workspaceId: number) => void
}

/**
 * Shared inline-input look for the inline "create" fields (new label / team /
 * sub-task). A thin transparent border that only firms up on focus — no chunky
 * gray focus ring (per the project's light-border UI guideline).
 */
const INLINE_INPUT =
  'h-7 text-sm bg-muted/30 rounded-md px-2.5 outline-none border border-transparent ' +
  'focus:border-border/60 focus:bg-muted/40 placeholder:text-muted-foreground/40 transition-colors'

export function TaskDetailView({
  detail,
  agents,
  sessions,
  onClose,
  onOpenWorkspace,
}: TaskDetailViewProps) {
  const intl = useIntl()
  const update = useTaskStore((s) => s.update)
  const comment = useTaskStore((s) => s.comment)
  const dispatch = useTaskStore((s) => s.dispatch)
  const setArchived = useTaskStore((s) => s.setArchived)
  const prepare = useTaskStore((s) => s.prepare)

  // Children created before plan rows were split stored the whole Markdown row
  // in title and left description empty. Present those records correctly without
  // silently rewriting persisted task data.
  const legacyPlanText =
    detail.sddManaged && detail.parentTaskId != null && !detail.description
      ? splitPlanTaskText(detail.title)
      : null
  const displayedTitle = legacyPlanText?.title ?? detail.title
  const displayedDescription = legacyPlanText?.description ?? detail.description

  const [dispatching, setDispatching] = useState(false)
  const [dispatchSubtasks, setDispatchSubtasks] = useState<PreparedSubtask[] | null>(null)
  const [verifyOpen, setVerifyOpen] = useState(false)
  const isArchived = detail.archivedAt != null
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(displayedTitle)
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState(displayedDescription)
  const [commentDraft, setCommentDraft] = useState('')
  const [sending, setSending] = useState(false)

  const updateDetail = (updates: UpdateTaskInput) => {
    void update(detail.id, updates).catch((error) => toastTaskError(error, 'Task update failed'))
  }

  const saveTitle = () => {
    setEditingTitle(false)
    const next = titleDraft.trim()
    if (next && next !== displayedTitle) {
      updateDetail({
        title: next,
        ...(legacyPlanText ? { description: legacyPlanText.description } : {}),
      })
    } else {
      setTitleDraft(displayedTitle)
    }
  }

  const saveDesc = () => {
    setEditingDesc(false)
    if (descDraft !== displayedDescription) {
      updateDetail({
        description: descDraft,
        ...(legacyPlanText ? { title: legacyPlanText.title } : {}),
      })
    }
  }

  const sendComment = async () => {
    const body = commentDraft.trim()
    if (!body) return
    setSending(true)
    try {
      await comment(detail.id, body)
      setCommentDraft('')
    } catch (error) {
      toastTaskError(error, 'Comment failed')
    } finally {
      setSending(false)
    }
  }

  const statusOptions = TASK_STATUSES.filter((s) => isValidTaskTransition(detail.status, s))

  return (
    // Phones stack the panels into one vertical scroll; md+ keeps the two-column
    // layout where each column scrolls independently.
    <div className="flex flex-col md:flex-row h-full overflow-y-auto md:overflow-hidden">
      {/* Left: content */}
      <div className="flex flex-col min-w-0 md:flex-1 md:min-h-0">
        <div className="h-11 flex items-center gap-2 px-4 border-b border-border/40 shrink-0 sticky top-0 z-10 bg-background md:static">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-foreground rounded-full h-7 px-2.5"
            onClick={onClose}
          >
            <ArrowLeft className="h-4 w-4" />
            <FormattedMessage id="task.detail.back" defaultMessage="Tasks" />
          </Button>
          <span className="text-xs text-muted-foreground/50 tabular-nums">#{detail.number}</span>
          {isArchived && (
            <span className="flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <Archive className="h-3 w-3" />
              <FormattedMessage id="task.detail.archivedBadge" defaultMessage="Archived" />
            </span>
          )}
        </div>

        <div className="md:flex-1 md:overflow-y-auto md:min-h-0 px-6 py-5 space-y-6 max-w-3xl">
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
                  setTitleDraft(displayedTitle)
                  setEditingTitle(false)
                }
              }}
              className="w-full text-xl font-semibold bg-transparent outline-none border-b border-border/50 pb-1"
            />
          ) : (
            <h1
              onClick={() => {
                setTitleDraft(displayedTitle)
                setEditingTitle(true)
              }}
              className="text-xl font-semibold leading-snug cursor-text hover:bg-muted/20 rounded px-1 -mx-1"
            >
              {displayedTitle}
            </h1>
          )}

          {/* Description */}
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/60 mb-2">
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
                    setDescDraft(displayedDescription)
                    setEditingDesc(false)
                  }
                }}
                placeholder={intl.formatMessage({ id: 'task.descriptionPlaceholder', defaultMessage: 'Add a description… (markdown supported)' })}
                className="w-full min-h-[120px] text-sm bg-muted/30 border border-border/50 rounded-lg p-3 outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/20 resize-y"
              />
            ) : (
              <div
                onClick={() => {
                  setDescDraft(displayedDescription)
                  setEditingDesc(true)
                }}
                className={cn(
                  'text-sm cursor-text rounded-lg p-3 min-h-[44px] transition-colors',
                  displayedDescription
                    ? 'text-foreground/80 -m-3 hover:bg-muted/20'
                    : 'border border-dashed border-border/50 hover:border-border/60 hover:bg-muted/20'
                )}
              >
                {displayedDescription ? (
                  <MarkdownRenderer content={displayedDescription} />
                ) : (
                  <span className="text-muted-foreground/40"><FormattedMessage id="task.detail.addDescription" defaultMessage="Add a description…" /></span>
                )}
              </div>
            )}
          </div>

          {/* Sub-tasks (epic path) */}
          <SubtasksSection detail={detail} />

          {/* SDD artifacts (spec/plan/acceptance + human approval gates) */}
          {detail.sddManaged && <SddArtifactsPanel task={detail} />}

          {/* Comment composer */}
          <div className="flex flex-col gap-2">
            <textarea
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendComment()
              }}
              placeholder={
                detail.bindingId != null
                  ? intl.formatMessage({ id: 'task.detail.commentPlaceholderWake', defaultMessage: 'Leave a comment — wakes the agent… (⌘↵ to send)' })
                  : intl.formatMessage({ id: 'task.detail.commentPlaceholder', defaultMessage: 'Leave a comment… (⌘↵ to send)' })
              }
              className="w-full min-h-[64px] text-sm bg-muted/30 border border-border/50 rounded-lg p-3 outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/20 resize-y"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                className="h-8"
                disabled={sending || !commentDraft.trim()}
                onClick={() => void sendComment()}
              >
                <FormattedMessage id="task.detail.comment" defaultMessage="Comment" />
              </Button>
            </div>
          </div>

          {/* Activity */}
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/60 mb-3">
              <FormattedMessage id="task.detail.activity" defaultMessage="Activity" />
            </div>
            <div className="space-y-3">
              {detail.activity.map((a) => (
                <ActivityItem key={a.id} activity={a} />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Right: properties — sidebar at md+, full-width section below on phones */}
      <div className="w-full md:w-72 shrink-0 border-border/40 border-t md:border-t-0 md:border-l md:overflow-y-auto">
        <div className="p-4 space-y-5">
          <PropertyRow label={intl.formatMessage({ id: 'task.detail.statusLabel', defaultMessage: 'Status' })}>
            <Select
              value={detail.status}
              onValueChange={(v) => updateDetail({ status: v as TaskStatus })}
            >
              <SelectTrigger className="h-8 bg-muted/30 border-transparent hover:bg-muted/50">
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
              <SelectTrigger className="h-8 bg-muted/30 border-transparent hover:bg-muted/50">
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
              value={detail.assignedAgentId ? String(detail.assignedAgentId) : 'unassigned'}
              onValueChange={(v) =>
                updateDetail({
                  assignedAgentId: v === 'unassigned' ? null : Number(v),
                })
              }
            >
              <SelectTrigger className="h-8 bg-muted/30 border-transparent hover:bg-muted/50">
                <span className="flex items-center gap-2">
                  <AssigneeAvatar
                    agentId={detail.assignedAgentId}
                    agents={agents}
                    sessions={sessions}
                  />
                  <span className="text-sm truncate">
                    {detail.assignedAgentId
                      ? agents.find((a) => a.id === detail.assignedAgentId)?.name ?? intl.formatMessage({ id: 'task.detail.unknownAgent', defaultMessage: 'Unknown' })
                      : intl.formatMessage({ id: 'task.unassigned', defaultMessage: 'Unassigned' })}
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
              </SelectContent>
            </Select>
          </PropertyRow>

          <PropertyRow label={intl.formatMessage({ id: 'task.detail.teamLabel', defaultMessage: 'Team' })}>
            <TeamPicker detail={detail} />
          </PropertyRow>

          <PropertyRow label={intl.formatMessage({ id: 'task.detail.labelsLabel', defaultMessage: 'Labels' })}>
            <LabelPicker detail={detail} />
          </PropertyRow>

          {detail.branchName && (
            <PropertyRow label={intl.formatMessage({ id: 'task.detail.branchLabel', defaultMessage: 'Branch' })}>
              <div className="flex items-center gap-1.5 text-xs font-mono text-foreground/80 bg-muted/30 rounded-md px-2 py-1.5">
                <GitBranch className="w-3 h-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{detail.branchName}</span>
              </div>
            </PropertyRow>
          )}

          {detail.workspaceId && onOpenWorkspace && (
            <Button
              size="sm"
              variant="ghost"
              className="w-full gap-2 h-8 hover:bg-muted/50"
              onClick={() => onOpenWorkspace(detail.workspaceId!)}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <FormattedMessage id="task.detail.openWorkspace" defaultMessage="Open Workspace" />
            </Button>
          )}

          {/* Verify — opt-in independent check of a finished change (§11.2⑦). Only
              offered for a parent change in review, where Gate-2p guarantees every
              subtask already merged, so the verifier sees the whole change. Skipping
              is a supported path: setting Status to Done signs off directly, and the
              acceptance it records says no verification ran. */}
          {detail.sddManaged && detail.parentTaskId == null && detail.status === 'in_review' && (
            <Button
              size="sm"
              variant="secondary"
              className="w-full gap-2 h-8"
              onClick={() => setVerifyOpen(true)}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <FormattedMessage id="task.detail.verify" defaultMessage="Run verifier" />
            </Button>
          )}

          {verifyOpen && (
            <VerifyDialog
              taskId={detail.id}
              agents={agents}
              implementerAgentId={detail.assignedAgentId}
              onClose={() => setVerifyOpen(false)}
              onDispatched={() => setVerifyOpen(false)}
            />
          )}

          {/* Dispatch — start (or restart) the assigned agent in the task worktree.
              Shown whenever the task is assigned and has no live execution session,
              regardless of status — so a task that reached in_progress without ever
              being dispatched (e.g. an agent flipped it via update_project_task) isn't stuck
              with no way to launch the executor. */}
          {detail.assignedAgentId &&
            detail.executionStatus !== 'active' &&
            detail.executionStatus !== 'idle' && (
              <Button
                size="sm"
                variant="secondary"
                className="w-full gap-2 h-8"
                disabled={dispatching}
                onClick={async () => {
                  if (detail.assignedAgentId == null) return
                  setDispatching(true)
                  try {
                    // SDD feature parent → prepare (approve + decompose) then let
                    // the user pick an agent per subtask. Tiny changes (no subtasks)
                    // and non-SDD tasks dispatch straight through.
                    if (detail.sddManaged && detail.parentTaskId == null) {
                      const subs = await prepare(detail.id)
                      if (subs.length > 0) {
                        setDispatchSubtasks(subs)
                        return
                      }
                    }
                    await dispatch(detail.id, detail.assignedAgentId)
                  } catch (error) {
                    toastTaskError(error, 'Dispatch failed')
                  } finally {
                    setDispatching(false)
                  }
                }}
              >
                <Zap className="w-3.5 h-3.5" />
                {dispatching
                  ? intl.formatMessage({ id: 'task.detail.dispatching', defaultMessage: 'Dispatching…' })
                  : detail.bindingId != null
                    ? intl.formatMessage({ id: 'task.detail.redispatch', defaultMessage: 'Re-dispatch' })
                    : intl.formatMessage({ id: 'task.detail.dispatch', defaultMessage: 'Dispatch' })}
              </Button>
            )}

          {dispatchSubtasks && (
            <DispatchDialog
              taskId={detail.id}
              subtasks={dispatchSubtasks}
              agents={agents}
              defaultAgentId={detail.assignedAgentId}
              onClose={() => setDispatchSubtasks(null)}
              onDispatched={() => setDispatchSubtasks(null)}
            />
          )}

          {/* Execution session status — the agent running IN the task worktree,
              not a channel session of the same agent. Absent until dispatched. */}
          {detail.assignedAgentId && detail.executionStatus && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
              <Bot className="w-3.5 h-3.5" />
              <span>{agents.find((a) => a.id === detail.assignedAgentId)?.name}</span>
              <span
                className={cn(
                  'inline-flex items-center gap-1',
                  detail.executionStatus === 'active' && 'text-blue-500',
                  detail.executionStatus === 'idle' && 'text-green-500',
                )}
              >
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full',
                    detail.executionStatus === 'active' && 'bg-blue-500 animate-pulse',
                    detail.executionStatus === 'idle' && 'bg-green-500',
                    detail.executionStatus === 'offline' && 'bg-muted-foreground/40',
                  )}
                />
                {detail.executionStatus}
              </span>
            </div>
          )}

          {/* Archive — retire the task from the board (or restore it). */}
          <div className="pt-2 mt-2 border-t border-border/40">
            <Button
              size="sm"
              variant="ghost"
              className="w-full gap-2 h-8 text-muted-foreground hover:text-foreground hover:bg-muted/50"
              onClick={() => {
                void setArchived(detail.id, !isArchived).catch((error) =>
                  toastTaskError(error, isArchived ? 'Unarchive failed' : 'Archive failed'),
                )
              }}
            >
              {isArchived ? (
                <>
                  <ArchiveRestore className="w-3.5 h-3.5" />
                  <FormattedMessage id="task.detail.unarchive" defaultMessage="Unarchive" />
                </>
              ) : (
                <>
                  <Archive className="w-3.5 h-3.5" />
                  <FormattedMessage id="task.detail.archive" defaultMessage="Archive" />
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/60">
        {label}
      </div>
      {children}
    </div>
  )
}

function LabelPicker({ detail }: { detail: TaskDetail }) {
  const intl = useIntl()
  const labels = useTaskStore((s) => s.labels)
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
      const label = await createLabel({ name })
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
        <button className="w-full flex flex-wrap items-center gap-1 min-h-8 rounded-md bg-muted/30 hover:bg-muted/50 px-2 py-1.5 transition-colors">
          {detail.labels.length > 0 ? (
            detail.labels.map((l) => <LabelChip key={l.id} label={l} />)
          ) : (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground/50">
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
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 text-sm transition-colors"
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

function TeamPicker({ detail }: { detail: TaskDetail }) {
  const intl = useIntl()
  const teams = useTaskStore((s) => s.teams)
  const update = useTaskStore((s) => s.update)
  const createTeam = useTaskStore((s) => s.createTeam)
  const [newName, setNewName] = useState('')

  const setTeam = (teamId: number | null) => {
    void update(detail.id, { teamId }).catch((error) =>
      toastTaskError(error, 'Task update failed'),
    )
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      const team = await createTeam({ name })
      setNewName('')
      await update(detail.id, { teamId: team.id })
    } catch (error) {
      toastTaskError(error, 'Team update failed')
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="w-full flex items-center gap-2 min-h-8 rounded-md bg-muted/30 hover:bg-muted/50 px-2 py-1.5 transition-colors">
          {detail.team ? (
            <>
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: detail.team.color }}
              />
              <span className="text-sm truncate">{detail.team.name}</span>
            </>
          ) : (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground/50">
              <Users className="w-3.5 h-3.5" />
              <FormattedMessage id="task.noTeam" defaultMessage="No team" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-60 p-0 overflow-hidden rounded-lg border border-border/50 bg-popover/95 backdrop-blur-sm shadow-float"
      >
        <div className="max-h-52 overflow-y-auto p-1">
          <button
            onClick={() => setTeam(null)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 text-sm transition-colors"
          >
            <span className="w-2 h-2 rounded-full border border-muted-foreground/40 shrink-0" />
            <span className="flex-1 text-left"><FormattedMessage id="task.noTeam" defaultMessage="No team" /></span>
            {detail.teamId == null && <Check className="w-3.5 h-3.5 text-primary" />}
          </button>
          {teams.map((t) => (
            <button
              key={t.id}
              onClick={() => setTeam(t.id)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 text-sm transition-colors"
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
              <span className="flex-1 text-left truncate">{t.name}</span>
              {detail.teamId === t.id && <Check className="w-3.5 h-3.5 text-primary" />}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 border-t border-border/40 p-1.5">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate()
            }}
            placeholder={intl.formatMessage({ id: 'task.detail.newTeamPlaceholder', defaultMessage: 'New team…' })}
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
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/60">
          <FormattedMessage id="task.detail.subtasks" defaultMessage="Sub-tasks" />
          {children.length > 0 && (
            <span className="ml-1.5 text-muted-foreground/40 tabular-nums">
              {done}/{children.length}
            </span>
          )}
        </div>
        <button
          onClick={() => setAdding((v) => !v)}
          className="text-muted-foreground/60 hover:text-foreground transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="space-y-0.5">
        {children.map((c) => (
          <button
            key={c.id}
            onClick={() => void openDetail(c.id)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/30 text-left transition-colors"
          >
            <StatusIcon status={c.status} />
            <span className="text-xs text-muted-foreground/50 tabular-nums">#{c.number}</span>
            <span className="flex-1 text-sm truncate text-foreground/90">{c.title}</span>
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
            className="w-full text-left text-xs text-muted-foreground/50 rounded-lg border border-dashed border-border/50 px-3 py-2 hover:border-border/60 hover:bg-muted/20 hover:text-muted-foreground transition-colors"
          >
            <FormattedMessage id="task.detail.addSubtask" defaultMessage="+ Add sub-task" />
          </button>
        )}
      </div>
    </div>
  )
}

function ActivityItem({ activity: a }: { activity: TaskActivity }) {
  const intl = useIntl()
  if (a.kind === 'comment') {
    return (
      <div className="flex flex-col gap-1 rounded-lg bg-muted/20 p-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-foreground/80">{a.actorName}</span>
          <span className="text-muted-foreground/40">{relativeTime(a.createdAt)}</span>
        </div>
        <div className="text-sm text-foreground/80">
          <MarkdownRenderer content={a.body} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground/60 px-1">
      <span className="w-1 h-1 rounded-full bg-muted-foreground/30 shrink-0" />
      <span className="font-medium text-foreground/60">{a.actorName}</span>
      <span>{describeEvent(a, intl)}</span>
      <span className="text-muted-foreground/30">{relativeTime(a.createdAt)}</span>
    </div>
  )
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
    case 'system':
      return a.body || intl.formatMessage({ id: 'task.activity.updated', defaultMessage: 'updated the task' })
    default:
      return a.body
  }
}
