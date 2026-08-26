import { useEffect, useMemo, useState } from "react"
import { FormattedMessage, defineMessages, useIntl } from "react-intl"
import { Loader2, ExternalLink } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api } from "@/lib/api"
import { LinearIcon } from "@/components/icons/LinearIcon"

const inputCn =
  "w-full px-3 py-2 text-sm bg-muted/30 rounded-xl border border-transparent hover:bg-muted/50 focus:bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/40 transition-colors"

const textareaCn =
  "w-full px-3 py-2 text-sm bg-muted/30 rounded-xl border border-transparent hover:bg-muted/50 focus:bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/40 font-mono resize-none transition-colors"

const cleanTriggerCn =
  "w-full bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none transition-colors"

const cleanContentProps = {
  align: "start" as const,
  position: "popper" as const,
  sideOffset: 6,
  className: "z-[80]",
}

const NO_PROJECT = "__none__"

const PRIORITY_MESSAGES = defineMessages({
  0: { id: "editor.linear.priority.none", defaultMessage: "No priority" },
  1: { id: "editor.linear.priority.urgent", defaultMessage: "Urgent" },
  2: { id: "editor.linear.priority.high", defaultMessage: "High" },
  3: { id: "editor.linear.priority.medium", defaultMessage: "Medium" },
  4: { id: "editor.linear.priority.low", defaultMessage: "Low" },
})

const PRIORITY_VALUES = [0, 1, 2, 3, 4] as const

const LAST_TEAM_KEY = "xui:integration:linear:lastTeamId"

interface LinearTeam {
  id: string
  name: string
  key: string
  projects: Array<{ id: string; name: string }>
  labels: Array<{ id: string; name: string; color: string }>
}

interface LinearShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  messageText: string
}

export function LinearShareDialog({ open, onOpenChange, messageText }: LinearShareDialogProps) {
  const intl = useIntl()
  const [loading, setLoading] = useState(false)
  const [teams, setTeams] = useState<LinearTeam[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [teamId, setTeamId] = useState("")
  const [projectId, setProjectId] = useState<string>(NO_PROJECT)
  const [priority, setPriority] = useState<number>(0)
  const [labelIds, setLabelIds] = useState<string[]>([])

  const [submitting, setSubmitting] = useState(false)
  const [teamDetails, setTeamDetails] = useState<
    Record<string, { projects: LinearTeam['projects']; labels: LinearTeam['labels'] }>
  >({})

  useEffect(() => {
    if (!open) return
    setTitle(messageText.slice(0, 60).trim() || intl.formatMessage({ id: "editor.linear.defaultTitle", defaultMessage: "Shared from operon" }))
    setDescription(messageText)
    setLabelIds([])
    setProjectId(NO_PROJECT)
    setPriority(0)
    setLoadError(null)
  }, [open, messageText])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const res = (await api.integrationLinearTeams()) as {
          teams?: LinearTeam[]
          error?: string
        }
        if (cancelled) return
        if (res.error || !Array.isArray(res.teams)) {
          setLoadError(res.error ?? intl.formatMessage({ id: "editor.linear.loadFailed", defaultMessage: "Failed to load Linear teams" }))
          setTeams([])
          return
        }
        setTeams(res.teams)
        const lastTeamId = localStorage.getItem(LAST_TEAM_KEY) ?? ""
        const initialTeam =
          (lastTeamId && res.teams.find((t) => t.id === lastTeamId)?.id) ||
          res.teams[0]?.id ||
          ""
        setTeamId(initialTeam)
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : intl.formatMessage({ id: "editor.linear.loadFailed", defaultMessage: "Failed to load Linear teams" }))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  const selectedTeam = useMemo(() => {
    const base = teams.find((t) => t.id === teamId)
    if (!base) return null
    const details = teamDetails[teamId]
    if (!details) return base
    return { ...base, projects: details.projects, labels: details.labels }
  }, [teams, teamId, teamDetails])

  useEffect(() => {
    if (!teamId || teamDetails[teamId]) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.integrationLinearTeamDetails(teamId)
        if (cancelled) return
        setTeamDetails((prev) => ({
          ...prev,
          [teamId]: {
            projects: res.projects ?? [],
            labels: res.labels ?? [],
          },
        }))
      } catch {
        // ignore — fields just stay empty
      }
    })()
    return () => {
      cancelled = true
    }
  }, [teamId, teamDetails])

  const handleSubmit = async () => {
    if (!teamId || !title.trim()) return
    setSubmitting(true)
    try {
      const res = await api.integrationLinearCreateIssue({
        teamId,
        title: title.trim(),
        description: description || undefined,
        projectId: projectId !== NO_PROJECT ? projectId : undefined,
        priority: priority > 0 ? priority : undefined,
        labelIds: labelIds.length > 0 ? labelIds : undefined,
      })
      localStorage.setItem(LAST_TEAM_KEY, teamId)
      toast.success(
        <div className="flex items-center gap-2">
          <span><FormattedMessage id="editor.linear.created" defaultMessage="Created {identifier}" values={{ identifier: res.issue.identifier }} /></span>
          <a
            href={res.issue.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <FormattedMessage id="editor.openLink" defaultMessage="Open" /> <ExternalLink className="h-3 w-3" />
          </a>
        </div>,
      )
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : intl.formatMessage({ id: "editor.linear.createFailed", defaultMessage: "Failed to create Linear issue" }))
    } finally {
      setSubmitting(false)
    }
  }

  const toggleLabel = (id: string) => {
    setLabelIds((prev) => (prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LinearIcon className="h-5 w-5" />
            <FormattedMessage id="editor.linear.title" defaultMessage="Share to Linear" />
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            <FormattedMessage id="editor.linear.loadingTeams" defaultMessage="Loading teams…" />
          </div>
        ) : loadError ? (
          <div className="py-6 text-sm text-red-500">{loadError}</div>
        ) : (
          <div className="space-y-4">
            <Field label={intl.formatMessage({ id: "editor.field.title", defaultMessage: "Title" })}>
              <input
                className={inputCn}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={intl.formatMessage({ id: "editor.linear.titlePlaceholder", defaultMessage: "Issue title" })}
                spellCheck={false}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label={intl.formatMessage({ id: "editor.linear.fieldTeam", defaultMessage: "Team" })}>
                <Select value={teamId} onValueChange={setTeamId}>
                  <SelectTrigger className={cleanTriggerCn}>
                    <SelectValue placeholder={intl.formatMessage({ id: "editor.linear.selectTeam", defaultMessage: "Select team" })} />
                  </SelectTrigger>
                  <SelectContent {...cleanContentProps}>
                    {teams.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                        <span className="text-muted-foreground/60 ml-1">({t.key})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label={intl.formatMessage({ id: "editor.linear.fieldProject", defaultMessage: "Project" })}>
                <Select
                  value={projectId}
                  onValueChange={setProjectId}
                  disabled={!selectedTeam}
                >
                  <SelectTrigger className={cleanTriggerCn}>
                    <SelectValue placeholder={intl.formatMessage({ id: "editor.linear.noProject", defaultMessage: "No project" })} />
                  </SelectTrigger>
                  <SelectContent {...cleanContentProps}>
                    <SelectItem value={NO_PROJECT}><FormattedMessage id="editor.linear.noProject" defaultMessage="No project" /></SelectItem>
                    {selectedTeam?.projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field label={intl.formatMessage({ id: "editor.linear.fieldPriority", defaultMessage: "Priority" })}>
              <Select
                value={String(priority)}
                onValueChange={(v) => setPriority(Number(v))}
              >
                <SelectTrigger className={cleanTriggerCn}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent {...cleanContentProps}>
                  {PRIORITY_VALUES.map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {intl.formatMessage(PRIORITY_MESSAGES[value])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {selectedTeam && selectedTeam.labels.length > 0 && (
              <Field label={intl.formatMessage({ id: "editor.linear.fieldLabels", defaultMessage: "Labels" })}>
                <div className="flex flex-wrap gap-1.5">
                  {selectedTeam.labels.map((label) => {
                    const active = labelIds.includes(label.id)
                    return (
                      <button
                        key={label.id}
                        type="button"
                        onClick={() => toggleLabel(label.id)}
                        className={
                          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors border " +
                          (active
                            ? "bg-primary/15 border-primary/40 text-foreground"
                            : "bg-background/60 border-border/50 text-muted-foreground hover:text-foreground")
                        }
                      >
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: label.color }}
                        />
                        {label.name}
                      </button>
                    )
                  })}
                </div>
              </Field>
            )}

            <Field label={intl.formatMessage({ id: "editor.field.description", defaultMessage: "Description" })}>
              <textarea
                className={textareaCn}
                rows={6}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={intl.formatMessage({ id: "editor.linear.descPlaceholder", defaultMessage: "Issue description (Markdown supported)" })}
                spellCheck={false}
              />
            </Field>
          </div>
        )}

        <DialogFooter>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => onOpenChange(false)} disabled={submitting}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 gap-1.5"
            onClick={handleSubmit}
            disabled={submitting || loading || !!loadError || !teamId || !title.trim()}
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <FormattedMessage id="editor.linear.createIssue" defaultMessage="Create Issue" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">
        {label}
      </label>
      {children}
    </div>
  )
}
