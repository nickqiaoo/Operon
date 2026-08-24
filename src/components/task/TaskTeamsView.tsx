import { useMemo, useState } from 'react'
import { ChevronRight, Plus, Users, Loader2, Check, MoreHorizontal, Trash2 } from 'lucide-react'
import { useIntl, FormattedMessage } from 'react-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { AgentAvatar } from '@/components/channel/AgentAvatar'
import { StatusIcon, PriorityIcon, LabelChip, AssigneeAvatar, relativeTime } from './task-meta'
import { TASK_STATUSES } from '@/types/task'
import type { TaskListItem, Team } from '@/types/task'
import type { Agent, AgentSession } from '@/types/channel'

const STATUS_RANK: Record<string, number> = Object.fromEntries(
  TASK_STATUSES.map((s, i) => [s, i]),
)

const TEAM_COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6']

interface TaskTeamsViewProps {
  tasks: TaskListItem[]
  teams: Team[]
  agents: Agent[]
  sessions: AgentSession[]
  onOpen: (taskId: number) => void
  onCreateTeam: (name: string, color: string) => Promise<unknown>
  onUpdateTeam: (teamId: number, name: string, color: string) => Promise<unknown>
  onDeleteTeam: (teamId: number) => Promise<unknown>
}

/** A team (or the synthetic "No team" bucket) plus the tasks/members it owns. */
interface TeamBucket {
  key: string
  id: number | null
  name: string
  color: string
  synthetic: boolean
  tasks: TaskListItem[]
}

export function TaskTeamsView({
  tasks,
  teams,
  agents,
  sessions,
  onOpen,
  onCreateTeam,
  onUpdateTeam,
  onDeleteTeam,
}: TaskTeamsViewProps) {
  const buckets: TeamBucket[] = useMemo(() => {
    const byTeam = new Map<number, TaskListItem[]>()
    const noTeam: TaskListItem[] = []
    for (const t of tasks) {
      if (t.teamId == null) noTeam.push(t)
      else {
        const list = byTeam.get(t.teamId) ?? []
        list.push(t)
        byTeam.set(t.teamId, list)
      }
    }
    const real: TeamBucket[] = teams.map((tm) => ({
      key: String(tm.id),
      id: tm.id,
      name: tm.name,
      color: tm.color,
      synthetic: false,
      tasks: byTeam.get(tm.id) ?? [],
    }))
    if (noTeam.length > 0) {
      real.push({ key: 'none', id: null, name: 'No team', color: '#71717a', synthetic: true, tasks: noTeam })
    }
    return real
  }, [tasks, teams])

  return (
    <ScrollArea className="h-full" viewportClassName="[&>div]:!block">
      <div className="max-w-3xl mx-auto px-5 py-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground/80 flex items-center gap-2">
            <Users className="w-4 h-4 text-muted-foreground" />
            <FormattedMessage id="task.teams.title" defaultMessage="Teams" />
            <span className="text-muted-foreground/50 tabular-nums font-normal">{teams.length}</span>
          </h2>
          <NewTeamInline onCreate={onCreateTeam} />
        </div>

        {buckets.length === 0 ? (
          <EmptyTeams />
        ) : (
          buckets.map((b) => (
            <TeamCard
              key={b.key}
              bucket={b}
              agents={agents}
              sessions={sessions}
              onOpen={onOpen}
              onUpdateTeam={onUpdateTeam}
              onDeleteTeam={onDeleteTeam}
            />
          ))
        )}
      </div>
    </ScrollArea>
  )
}

function TeamCard({
  bucket,
  agents,
  sessions,
  onOpen,
  onUpdateTeam,
  onDeleteTeam,
}: {
  bucket: TeamBucket
  agents: Agent[]
  sessions: AgentSession[]
  onOpen: (taskId: number) => void
  onUpdateTeam: (teamId: number, name: string, color: string) => Promise<unknown>
  onDeleteTeam: (teamId: number) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)

  const members = useMemo(() => {
    const ids = new Set<number>()
    for (const t of bucket.tasks) if (t.assignedAgentId != null) ids.add(t.assignedAgentId)
    return agents.filter((a) => ids.has(a.id))
  }, [bucket.tasks, agents])

  const total = bucket.tasks.filter((t) => t.status !== 'cancelled').length
  const done = bucket.tasks.filter((t) => t.status === 'done').length
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)

  const sorted = useMemo(
    () =>
      [...bucket.tasks].sort(
        (a, b) =>
          (STATUS_RANK[a.status] ?? 0) - (STATUS_RANK[b.status] ?? 0) ||
          b.priority - a.priority ||
          a.number - b.number,
      ),
    [bucket.tasks],
  )

  return (
    <div className="rounded-xl border border-border/60 bg-popover/90 overflow-hidden shadow-input dark:border-border/35 dark:bg-popover/70">
      <div className="flex items-center gap-1 px-2 py-2 hover:bg-muted/15 transition-colors">
        <button
          onClick={() => setOpen((v) => !v)}
          className="min-w-0 flex-1 flex items-center gap-2 sm:gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-muted/25 transition-colors"
        >
          <ChevronRight
            className={cn(
              'w-4 h-4 text-muted-foreground/50 shrink-0 transition-transform',
              open && 'rotate-90',
            )}
          />
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: bucket.color }}
          />
          <span
            className={cn(
              'text-sm font-semibold truncate',
              bucket.synthetic ? 'text-muted-foreground' : 'text-foreground/90',
            )}
          >
            {bucket.synthetic ? <FormattedMessage id="task.noTeam" defaultMessage="No team" /> : bucket.name}
          </span>
          <span className="text-xs text-muted-foreground/50 tabular-nums">{bucket.tasks.length}</span>

          <div className="flex-1" />

          <div className="hidden sm:contents">
            <MemberStack members={members} sessions={sessions} />
          </div>

          <div className="flex items-center gap-2 w-28 sm:w-40 shrink-0">
            <div className="flex-1 h-1.5 rounded-full bg-muted/50 overflow-hidden">
              <div
                className="h-full rounded-full bg-green-500/70 transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[11px] text-muted-foreground/60 tabular-nums w-10 text-right">
              {done}/{total}
            </span>
          </div>
        </button>

        {!bucket.synthetic && bucket.id != null && (
          <TeamManagePopover
            teamId={bucket.id}
            name={bucket.name}
            color={bucket.color}
            taskCount={bucket.tasks.length}
            onUpdate={onUpdateTeam}
            onDelete={onDeleteTeam}
          />
        )}
      </div>

      {open && (
        <div className="border-t border-border/40">
          {sorted.length === 0 ? (
            <p className="px-5 py-4 text-xs text-muted-foreground/50"><FormattedMessage id="task.teams.emptyTeam" defaultMessage="No tasks in this team yet." /></p>
          ) : (
            sorted.map((task) => (
              <TeamTaskRow
                key={task.id}
                task={task}
                agents={agents}
                sessions={sessions}
                onClick={() => onOpen(task.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function TeamManagePopover({
  teamId,
  name,
  color,
  taskCount,
  onUpdate,
  onDelete,
}: {
  teamId: number
  name: string
  color: string
  taskCount: number
  onUpdate: (teamId: number, name: string, color: string) => Promise<unknown>
  onDelete: (teamId: number) => Promise<unknown>
}) {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const [draftName, setDraftName] = useState(name)
  const [draftColor, setDraftColor] = useState(color)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const resetDraft = () => {
    setDraftName(name)
    setDraftColor(color)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) resetDraft()
    setOpen(nextOpen)
  }

  const save = async () => {
    const trimmed = draftName.trim()
    if (!trimmed || saving || deleting) return
    if (trimmed === name && draftColor === color) {
      setOpen(false)
      return
    }
    setSaving(true)
    try {
      await onUpdate(teamId, trimmed, draftColor)
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    const ok = window.confirm(
      intl.formatMessage(
        {
          id: 'task.teams.deleteConfirm',
          defaultMessage:
            'Delete team "{name}"? Its {count, plural, one {# task} other {# tasks}} will move to No team.',
        },
        { name, count: taskCount },
      ),
    )
    if (!ok || deleting || saving) return
    setDeleting(true)
    try {
      await onDelete(teamId)
      setOpen(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-muted/35 hover:text-foreground"
          aria-label={intl.formatMessage({ id: 'task.teams.manage', defaultMessage: 'Manage team' })}
          title={intl.formatMessage({ id: 'task.teams.manage', defaultMessage: 'Manage team' })}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-64 rounded-xl border border-border/50 bg-popover/95 p-3 shadow-float backdrop-blur-sm"
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              <FormattedMessage id="task.teams.name" defaultMessage="Name" />
            </div>
            <Input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
                if (e.key === 'Escape') setOpen(false)
              }}
              className="h-8 border-border/40 bg-muted/25 text-sm shadow-none"
            />
          </div>

          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              <FormattedMessage id="task.teams.color" defaultMessage="Color" />
            </div>
            <div className="flex items-center gap-1.5">
              {TEAM_COLORS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setDraftColor(item)}
                  className={cn(
                    'h-5 w-5 rounded-full transition-transform',
                    draftColor === item
                      ? 'scale-110 ring-2 ring-foreground/35 ring-offset-2 ring-offset-popover'
                      : 'opacity-75 hover:opacity-100',
                  )}
                  style={{ backgroundColor: item }}
                  aria-label={intl.formatMessage({ id: 'task.teams.pickColor', defaultMessage: 'Pick color' })}
                  title={item}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="secondary"
              className="h-8 flex-1 gap-1.5"
              disabled={!draftName.trim() || saving || deleting}
              onClick={() => void save()}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              <FormattedMessage id="common.save" defaultMessage="Save" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-muted-foreground"
              disabled={saving || deleting}
              onClick={() => setOpen(false)}
            >
              <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
            </Button>
          </div>

          <button
            type="button"
            disabled={saving || deleting}
            onClick={() => void remove()}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-destructive/80 hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
          >
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            <FormattedMessage id="task.teams.delete" defaultMessage="Delete team" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function MemberStack({ members, sessions }: { members: Agent[]; sessions: AgentSession[] }) {
  if (members.length === 0) {
    return <span className="text-[11px] text-muted-foreground/40 shrink-0"><FormattedMessage id="task.teams.noMembers" defaultMessage="No members" /></span>
  }
  const shown = members.slice(0, 5)
  const extra = members.length - shown.length
  return (
    <div className="flex items-center shrink-0">
      <div className="flex -space-x-2">
        {shown.map((a) => {
          const status = sessions.find((s) => s.agentId === a.id)?.status ?? 'offline'
          return (
            <span
              key={a.id}
              className="ring-2 ring-background rounded-full"
              title={`${a.name} · ${status}`}
            >
              <AgentAvatar provider={a.provider} size="sm" />
            </span>
          )
        })}
      </div>
      {extra > 0 && (
        <span className="ml-1 text-[11px] text-muted-foreground/50 tabular-nums">+{extra}</span>
      )}
    </div>
  )
}

function TeamTaskRow({
  task,
  agents,
  sessions,
  onClick,
}: {
  task: TaskListItem
  agents: Agent[]
  sessions: AgentSession[]
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-5 py-2 text-left border-b border-border/40 last:border-b-0 hover:bg-muted/20 transition-colors"
    >
      <StatusIcon status={task.status} />
      <PriorityIcon priority={task.priority} />
      <span className="text-xs text-muted-foreground/50 tabular-nums w-12 shrink-0">
        #{task.number}
      </span>
      <span className="flex-1 truncate text-sm text-foreground/90">{task.title}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        {task.labels.slice(0, 2).map((l) => (
          <LabelChip key={l.id} label={l} />
        ))}
      </div>
      <span className="text-[11px] text-muted-foreground/40 tabular-nums w-9 text-right shrink-0">
        {relativeTime(task.updatedAt)}
      </span>
      <AssigneeAvatar agentId={task.assignedAgentId} agents={agents} sessions={sessions} />
    </button>
  )
}

function NewTeamInline({ onCreate }: { onCreate: (name: string, color: string) => Promise<unknown> }) {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [color, setColor] = useState(TEAM_COLORS[0])
  const [saving, setSaving] = useState(false)

  const reset = () => {
    setName('')
    setColor(TEAM_COLORS[0])
    setSaving(false)
  }

  const handleOpenChange = (next: boolean) => {
    if (next) reset()
    setOpen(next)
  }

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      await onCreate(trimmed, color)
      reset()
      setOpen(false)
    } catch {
      setSaving(false)
    }
  }

  // A floating Popover (mirrors TeamManagePopover) rather than an inline row: the
  // inline form's Create/Cancel buttons ran off the right edge on narrow phones.
  // Radix collision-detection keeps the panel inside the viewport on mobile.
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="secondary" className="h-8 gap-1.5">
          <Plus className="w-3.5 h-3.5" />
          <FormattedMessage id="task.teams.newTeam" defaultMessage="New team" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-64 rounded-xl border border-border/50 bg-popover/95 p-3 shadow-float backdrop-blur-sm"
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              <FormattedMessage id="task.teams.name" defaultMessage="Name" />
            </div>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
                if (e.key === 'Escape') setOpen(false)
              }}
              placeholder={intl.formatMessage({ id: 'task.teams.namePlaceholder', defaultMessage: 'Team name' })}
              className="h-8 border-border/40 bg-muted/25 text-sm shadow-none"
            />
          </div>

          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              <FormattedMessage id="task.teams.color" defaultMessage="Color" />
            </div>
            <div className="flex items-center gap-1.5">
              {TEAM_COLORS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setColor(item)}
                  className={cn(
                    'h-5 w-5 rounded-full transition-transform',
                    color === item
                      ? 'scale-110 ring-2 ring-foreground/35 ring-offset-2 ring-offset-popover'
                      : 'opacity-75 hover:opacity-100',
                  )}
                  style={{ backgroundColor: item }}
                  aria-label={intl.formatMessage({ id: 'task.teams.pickColor', defaultMessage: 'Pick color' })}
                  title={item}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="secondary"
              className="h-8 flex-1 gap-1.5"
              disabled={!name.trim() || saving}
              onClick={() => void submit()}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              <FormattedMessage id="common.create" defaultMessage="Create" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-muted-foreground"
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function EmptyTeams() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground/50 gap-2">
      <Users className="w-8 h-8 opacity-40" />
      <p className="text-sm"><FormattedMessage id="task.teams.empty.title" defaultMessage="No teams yet" /></p>
      <p className="text-xs"><FormattedMessage id="task.teams.empty.hint" defaultMessage="Create a team, or add sub-tasks to an epic to form one" /></p>
    </div>
  )
}
