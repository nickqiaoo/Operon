import { useEffect, useRef, useState, type ReactNode } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { Check, ChevronDown, CircleDashed, Folder, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { useProjectStore } from "@/stores/project-store"
import { useTaskStore } from "@/stores/task-store"
import { AgentAvatar } from "@/components/icons/AgentAvatar"
import { PriorityIcon } from "@/components/task/task-meta"
import { priorityMessage } from "@/components/task/task-i18n"
import { toastTaskError } from "@/components/task/task-error-toast"
import { TASK_PRIORITIES, type TaskPriority } from "@/types/task"
import type { Agent } from "@/types/channel"
import { MobileSheet } from "./MobileSheet"
import { useMobileTopInset } from "./MobileHeader"

type Picker = "project" | "priority" | "assignee" | null

/**
 * New task on a phone: a full-screen compose page rather than the desktop dialog.
 * The dialog floated under the native top bar, put its title on a form-field
 * ground, and lost its Create button under the keyboard. Here Create sits in the
 * header, the title and description are bare text on the page, and the three
 * properties are chips above the keyboard, each opening a sheet.
 */
export function MobileNewTaskPage({
  agents,
  defaultProjectId,
  keyboardOpen,
  onCancel,
  onCreated,
}: {
  agents: Agent[]
  /** The tab's project filter; null (every project) leaves the choice to the user. */
  defaultProjectId: number | null
  keyboardOpen: boolean
  onCancel: () => void
  onCreated: (taskId: number) => void
}) {
  const intl = useIntl()
  const projects = useProjectStore((s) => s.projects)
  const create = useTaskStore((s) => s.create)
  const [projectId, setProjectId] = useState<number | null>(defaultProjectId)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState<TaskPriority>(0)
  const [assigneeId, setAssigneeId] = useState<number | null>(null)
  const [picker, setPicker] = useState<Picker>(null)
  const [saving, setSaving] = useState(false)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const topInset = useMobileTopInset()

  // The description grows with its text; the page scrolls, not the field.
  useEffect(() => {
    const el = descriptionRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight}px`
  }, [description])

  const project = projects.find((p) => p.id === projectId) ?? null
  const assignee = agents.find((a) => a.id === assigneeId) ?? null
  const canCreate = title.trim().length > 0 && projectId != null && !saving

  const submit = async () => {
    if (!canCreate || projectId == null) return
    setSaving(true)
    try {
      const task = await create({
        projectId,
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        assignedAgentId: assigneeId,
      })
      onCreated(task.id)
    } catch (error) {
      toastTaskError(error, "Task create failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="flex h-full flex-col bg-background"
      style={{
        paddingTop: topInset,
        // The chips ride on the keyboard; without it they keep clear of the home indicator.
        paddingBottom: keyboardOpen ? "var(--keyboard-height)" : "env(safe-area-inset-bottom)",
      }}
    >
      <div className="grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-border/40 px-2">
        <button
          type="button"
          onClick={onCancel}
          className="justify-self-start rounded-lg px-2 py-1.5 text-base text-muted-foreground active:bg-row-hover"
        >
          <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
        </button>
        <span className="text-base font-semibold text-foreground/90">
          <FormattedMessage id="task.new.title" defaultMessage="New Task" />
        </span>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canCreate}
          className="flex items-center gap-1.5 justify-self-end rounded-lg px-2 py-1.5 text-base font-semibold text-brand disabled:text-muted-foreground/40"
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          <FormattedMessage id="common.create" defaultMessage="Create" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          enterKeyHint="next"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault()
              descriptionRef.current?.focus()
            }
          }}
          placeholder={intl.formatMessage({ id: "task.new.titlePlaceholder", defaultMessage: "Task title" })}
          className="w-full appearance-none border-0 bg-transparent p-0 text-xl font-semibold text-foreground outline-none placeholder:text-muted-foreground/40"
        />
        <textarea
          ref={descriptionRef}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder={intl.formatMessage({ id: "task.descriptionPlaceholder", defaultMessage: "Add a description… (markdown supported)" })}
          className="mt-3 w-full resize-none appearance-none border-0 bg-transparent p-0 text-base leading-relaxed text-foreground/90 outline-none placeholder:text-muted-foreground/40"
        />
      </div>

      <div className="flex shrink-0 gap-2 overflow-x-auto border-t border-border/40 px-3 py-2.5 [&>*]:shrink-0">
        <Chip
          onClick={() => setPicker("project")}
          icon={<Folder className="size-4" />}
          label={project?.name ?? intl.formatMessage({ id: "task.new.project", defaultMessage: "Project" })}
          missing={project == null}
        />
        <Chip
          onClick={() => setPicker("priority")}
          icon={<PriorityIcon priority={priority} className="size-4" />}
          label={intl.formatMessage(priorityMessage(priority))}
        />
        <Chip
          onClick={() => setPicker("assignee")}
          icon={assignee ? <AgentAvatar provider={assignee.provider} size="sm" /> : <CircleDashed className="size-4" />}
          label={assignee?.name ?? intl.formatMessage({ id: "task.unassigned", defaultMessage: "Unassigned" })}
        />
      </div>

      <MobileSheet
        open={picker === "project"}
        onClose={() => setPicker(null)}
        title={intl.formatMessage({ id: "task.new.project", defaultMessage: "Project" })}
      >
        {projects.map((p) => (
          <OptionRow
            key={p.id}
            selected={p.id === projectId}
            icon={<Folder className="size-4 text-muted-foreground" />}
            label={p.name}
            onClick={() => {
              setProjectId(p.id)
              setPicker(null)
            }}
          />
        ))}
      </MobileSheet>

      <MobileSheet
        open={picker === "priority"}
        onClose={() => setPicker(null)}
        title={intl.formatMessage({ id: "task.groupBy.priority", defaultMessage: "Priority" })}
      >
        {[...TASK_PRIORITIES].reverse().map((p) => (
          <OptionRow
            key={p}
            selected={p === priority}
            icon={<PriorityIcon priority={p} className="size-4" />}
            label={intl.formatMessage(priorityMessage(p))}
            onClick={() => {
              setPriority(p)
              setPicker(null)
            }}
          />
        ))}
      </MobileSheet>

      <MobileSheet
        open={picker === "assignee"}
        onClose={() => setPicker(null)}
        title={intl.formatMessage({ id: "task.assignee", defaultMessage: "Assignee" })}
      >
        <OptionRow
          selected={assigneeId == null}
          icon={<CircleDashed className="size-4 text-muted-foreground" />}
          label={intl.formatMessage({ id: "task.unassigned", defaultMessage: "Unassigned" })}
          onClick={() => {
            setAssigneeId(null)
            setPicker(null)
          }}
        />
        {agents.map((a) => (
          <OptionRow
            key={a.id}
            selected={a.id === assigneeId}
            icon={<AgentAvatar provider={a.provider} size="sm" />}
            label={a.name}
            onClick={() => {
              setAssigneeId(a.id)
              setPicker(null)
            }}
          />
        ))}
      </MobileSheet>
    </div>
  )
}

function Chip({ icon, label, onClick, missing = false }: { icon: ReactNode; label: string; onClick: () => void; missing?: boolean }) {
  return (
    <button
      type="button"
      // Keep the keyboard up: a tap on a chip must not blur the field being typed in.
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-9 max-w-[60vw] items-center gap-1.5 rounded-full border px-3 text-[14px] transition-colors active:bg-row-hover",
        missing ? "border-border/60 text-muted-foreground" : "border-border/50 text-foreground/85 dark:border-border/35",
      )}
    >
      <span className="flex shrink-0 items-center">{icon}</span>
      <span className="truncate">{label}</span>
      <ChevronDown className="size-3.5 shrink-0 opacity-50" />
    </button>
  )
}

function OptionRow({ icon, label, selected, onClick }: { icon: ReactNode; label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-base",
        selected ? "bg-row-selected text-foreground" : "text-foreground/85 active:bg-row-hover",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && <Check className="size-4 shrink-0 text-brand" />}
    </button>
  )
}
