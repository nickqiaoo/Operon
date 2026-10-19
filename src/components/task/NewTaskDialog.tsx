import { useRef, useState } from 'react'
import { useIntl, FormattedMessage } from 'react-intl'
import { Folder } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTaskStore } from '@/stores/task-store'
import { useProjectStore } from '@/stores/project-store'
import { PriorityIcon } from './task-meta'
import { priorityMessage } from './task-i18n'
import { TASK_PRIORITIES } from '@/types/task'
import type { TaskPriority } from '@/types/task'
import type { Agent } from '@/types/channel'

interface NewTaskDialogProps {
  agents: Agent[]
  /** The board's project filter; null (every project) leaves the choice to the user. */
  defaultProjectId: number | null
  onClose: () => void
  onCreated: (taskId: number) => void
}

export function NewTaskDialog({ agents, defaultProjectId, onClose, onCreated }: NewTaskDialogProps) {
  const intl = useIntl()
  const create = useTaskStore((s) => s.create)
  const projects = useProjectStore((s) => s.projects)
  // A task is dispatched into a worktree of its project's repo, so it needs one.
  const [projectId, setProjectId] = useState<string>(defaultProjectId != null ? String(defaultProjectId) : '')
  const savingRef = useRef(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<TaskPriority>(0)
  const [assignee, setAssignee] = useState<string>('unassigned')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const t = title.trim()
    if (!t || !projectId || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const task = await create({
        projectId: Number(projectId),
        title: t,
        description: description.trim() || undefined,
        priority,
        assignedAgentId: assignee === 'unassigned' ? null : Number(assignee),
      })
      onCreated(task.id)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle><FormattedMessage id="task.new.title" defaultMessage="New Task" /></DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <input
            autoFocus
            data-bare
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
            placeholder={intl.formatMessage({ id: 'task.new.titlePlaceholder', defaultMessage: 'Task title' })}
            className="w-full text-base font-medium bg-transparent outline-none placeholder:text-muted-foreground/40"
          />

          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={intl.formatMessage({ id: 'task.descriptionPlaceholder', defaultMessage: 'Add a description… (markdown supported)' })}
            className="w-full min-h-[100px] text-sm bg-muted/20 rounded-lg p-3 outline-none focus:border-tint/40 focus:ring-1 focus:ring-tint/10 resize-y placeholder:text-muted-foreground/40"
          />

          <div className="flex flex-wrap items-center gap-2">
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="h-8 w-auto max-w-56 gap-1.5 bg-muted/30 border-border/50 text-xs">
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <SelectValue placeholder={intl.formatMessage({ id: 'task.new.project', defaultMessage: 'Project' })} />
              </SelectTrigger>
              <SelectContent position="popper" align="start" sideOffset={6}>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={String(priority)} onValueChange={(v) => setPriority(Number(v) as TaskPriority)}>
              {/* The picked item's own content (icon + label) is what SelectValue shows. */}
              <SelectTrigger className="h-8 w-auto gap-1.5 bg-muted/30 border-border/50 text-xs">
                <SelectValue />
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

            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger className="h-8 w-auto gap-1.5 bg-muted/30 border-border/50 text-xs">
                <SelectValue placeholder={intl.formatMessage({ id: 'task.assignee', defaultMessage: 'Assignee' })} />
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
          </div>
        </div>

        <DialogFooter>
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onClose}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-8"
            disabled={!title.trim() || !projectId || saving}
            onClick={() => void submit()}
          >
            {saving
              ? intl.formatMessage({ id: 'task.new.creating', defaultMessage: 'Creating…' })
              : intl.formatMessage({ id: 'task.new.create', defaultMessage: 'Create Task' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
