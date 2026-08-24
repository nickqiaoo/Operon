import { useEffect, useState, useCallback } from 'react'
import {
  Check,
  Loader2,
  FileText,
  AlertCircle,
  GitMerge,
  Layers,
  ArrowUpRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { TaskArtifact, ArtifactKind } from '@/types/task'
import { useTaskStore } from '@/stores/task-store'

const KINDS: ArtifactKind[] = ['spec', 'plan', 'acceptance']
const KIND_LABEL: Record<ArtifactKind, string> = {
  spec: 'Spec',
  plan: 'Plan',
  acceptance: 'Acceptance',
  spec_delta: 'Delta',
}
const KIND_DESCRIPTION: Record<ArtifactKind, string> = {
  spec: 'User stories, requirements, scenarios, success criteria, and assumptions.',
  plan: 'Implementation slices mapped to files, tasks, and acceptance criteria.',
  acceptance: "The verifier's report: evidence per acceptance criterion, and the verdict you sign at Done.",
  spec_delta: 'Living-spec edits that sediment after the change is done.',
}

type StatTone = 'default' | 'accent' | 'success' | 'warning'

interface ArtifactStat {
  label: string
  value: number
  tone?: StatTone
}

// status-* tokens carry their own light/dark values, so these need no `dark:`
// half — see --color-status-ok in globals.css.
const STAT_TONE_CLASS: Record<StatTone, string> = {
  default: 'border-border/40 bg-muted/25 text-muted-foreground',
  accent: 'border-status-info/15 bg-status-info/10 text-status-info',
  success: 'border-status-ok/15 bg-status-ok/10 text-status-ok',
  warning: 'border-status-warn/15 bg-status-warn/10 text-status-warn',
}

const ARTIFACT_MARKDOWN_CLASS = cn(
  'text-[13px] text-foreground/85',
  'prose-headings:font-semibold prose-headings:tracking-normal prose-h1:text-xl prose-h1:mb-3',
  'prose-h2:mt-6 prose-h2:border-t prose-h2:border-border/40 prose-h2:pt-5 prose-h2:text-[15px]',
  'prose-h2:uppercase prose-h2:tracking-[0.08em] prose-h2:text-muted-foreground',
  'prose-h3:mt-4 prose-h3:rounded-lg prose-h3:bg-muted/35 prose-h3:px-3 prose-h3:py-2 prose-h3:text-[14px]',
  'prose-h4:mt-3 prose-h4:border-l-2 prose-h4:border-primary/25 prose-h4:pl-2 prose-h4:text-[13px]',
  'prose-p:my-1 prose-p:leading-6 prose-li:my-1 prose-li:leading-6 prose-ul:my-2 prose-ol:my-2',
  'prose-strong:text-foreground prose-code:rounded prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5',
  'prose-code:text-[0.92em] prose-code:before:content-none prose-code:after:content-none',
  'prose-pre:my-3 prose-pre:rounded-lg prose-pre:border prose-pre:border-border/40 prose-pre:bg-muted/30 prose-pre:p-3',
  'prose-blockquote:my-3 prose-blockquote:border-l-2 prose-blockquote:border-primary/25 prose-blockquote:bg-muted/25 prose-blockquote:px-3 prose-blockquote:py-2',
)

/** Minimal task shape the panel needs — the SDD parent/child fields. */
interface SddTask {
  id: number
  parentTaskId: number | null
  planAnchor: string | null
  claimedAcs: string[] | null
}

/**
 * Detail-page panel for a spec-driven task.
 *  - Parent: read-only view of spec/plan/acceptance (status + content from the
 *    change branch). Approving the spec/plan and decomposing the plan are folded
 *    into Dispatch (top of the task) — pressing Dispatch signs the design off and
 *    starts work — so this panel only keeps the later action: sediment the
 *    change into the living spec.
 *  - Child: shows which plan item + AC ids it owns, and lets a human merge its
 *    branch back into the parent once verified.
 * The canonical content lives in git; this only reads it.
 */
export function SddArtifactsPanel({ task }: { task: SddTask }) {
  const isChild = task.parentTaskId != null
  return isChild ? <SubtaskPanel task={task} /> : <ParentPanel taskId={task.id} />
}

// ---- Parent: artifacts (read-only) + acceptance + sediment ----

function ParentPanel({ taskId }: { taskId: number }) {
  const [artifacts, setArtifacts] = useState<TaskArtifact[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<string | null>(null)
  const [sedimentClean, setSedimentClean] = useState(false)

  const load = useCallback(async () => {
    const res = await api.sddArtifacts(taskId)
    setArtifacts(res.artifacts ?? [])
  }, [taskId])

  useEffect(() => {
    void load()
  }, [load])

  const sediment = async (apply: boolean) => {
    setBusy(apply ? 'sediment-apply' : 'sediment')
    setError(null)
    try {
      const res = await api.sddSediment(taskId, apply)
      if (res.error) {
        setError(res.error)
        setSedimentClean(false)
      } else if (res.result?.conflicts.length) {
        setReport(
          `Sediment blocked — ${res.result.capability}: semantic conflict(s):\n` +
            res.result.conflicts.map((x) => `- ${x.kind} ${x.id}: ${x.detail}`).join('\n'),
        )
        setSedimentClean(false)
      } else if (apply) {
        setReport(`Sedimented ${res.result?.capability} into the living spec (change branch).`)
        setSedimentClean(false)
      } else {
        setReport(`Preview — ${res.result?.capability} sediments cleanly:\n\n${res.result?.preview}`)
        setSedimentClean(true)
      }
    } finally {
      setBusy(null)
    }
  }

  if (!artifacts) return null
  // Every kind gets a tab, written or not: a greyed-out tab says "this artifact is
  // still missing", which is exactly what a reviewer needs to know at a glance.
  const slots = KINDS.map((kind) => ({ kind, artifact: artifacts.find((a) => a.kind === kind) }))
  const present = slots.filter((s) => s.artifact)
  const firstPresent = present[0]?.kind ?? KINDS[0]

  return (
    <section className="space-y-4 border-y border-border/40 py-5">
      <div className="flex items-start gap-3 px-0.5">
        <FileText className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
        <div>
          <div className="text-sm font-semibold mb-1">Spec-Driven Artifacts</div>
          <div className="text-xs text-muted-foreground">
            Read-only. Dispatch signs off the spec and plan and starts work; acceptance appears once
            a verifier reports on the finished change. The action below sediments it into the living
            spec.
          </div>
        </div>
      </div>

      {present.length === 0 ? (
        <div className="text-xs text-muted-foreground rounded-lg border border-dashed border-border/50 p-3">
          No artifacts yet — the spec author writes the spec through the agent workflow.
        </div>
      ) : (
        <Tabs defaultValue={firstPresent} className="gap-3">
          {/* Underline tabs: the bottom rule already separates this strip from the
              content, so it carries no fill of its own (see UI guidelines). */}
          <TabsList className="h-8 w-full justify-start gap-5 rounded-none border-0 border-b border-border/40 bg-transparent p-0">
            {slots.map(({ kind, artifact }) => (
              <TabsTrigger
                key={kind}
                value={kind}
                disabled={!artifact}
                className={cn(
                  'relative h-8 flex-none gap-1.5 rounded-none border-0 bg-transparent px-0.5 text-xs font-medium',
                  'text-muted-foreground transition-colors hover:text-foreground',
                  'data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none',
                  // 2px rule sitting on the list's bottom border marks the active tab.
                  'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full',
                  'after:bg-transparent data-[state=active]:after:bg-foreground/80',
                  'disabled:opacity-45',
                )}
              >
                {KIND_LABEL[kind]}
                {artifact ? (
                  <span
                    aria-hidden
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      artifact.status === 'approved' ? 'bg-status-ok' : 'bg-status-warn',
                    )}
                  />
                ) : (
                  <span className="text-[10px] font-normal text-muted-foreground/70">—</span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          {present.map(({ kind, artifact }) => (
            <TabsContent key={kind} value={kind}>
              <ArtifactPreview artifact={artifact as TaskArtifact} />
            </TabsContent>
          ))}
        </Tabs>
      )}

      {present.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            disabled={busy === 'sediment'}
            onClick={() => void sediment(false)}
          >
            {busy === 'sediment' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Layers className="h-3.5 w-3.5" />
            )}
            Preview sediment
          </Button>
          {sedimentClean && (
            <Button
              size="sm"
              variant="secondary"
              className="h-7 gap-1.5 text-xs"
              disabled={busy === 'sediment-apply'}
              onClick={() => void sediment(true)}
            >
              {busy === 'sediment-apply' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Apply sediment
            </Button>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}

      {report && (
        <div className="rounded-xl border border-border/40 bg-background/50">
          <div className="border-b border-border/40 px-4 py-3 text-xs font-semibold">
            Latest result
          </div>
          <div className="px-4 py-3">
            <MarkdownRenderer
              content={report}
              breaks
              className={cn(ARTIFACT_MARKDOWN_CLASS, 'prose-h2:mt-4 prose-h2:pt-4')}
            />
          </div>
        </div>
      )}
    </section>
  )
}

function ArtifactPreview({ artifact }: { artifact: TaskArtifact }) {
  const content = artifact.content?.trim() ?? ''
  const stats = getArtifactStats(artifact.kind, content)

  return (
    <article className="overflow-hidden rounded-xl border border-border/40 bg-background/55">
      <div className="flex flex-col gap-3 border-b border-border/40 bg-muted/15 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {/* The tab already names the artifact — only the status needs restating here. */}
          <ArtifactStatusBadge status={artifact.status} />
          <div className="mt-1.5 text-xs leading-5 text-muted-foreground">
            {KIND_DESCRIPTION[artifact.kind] ?? 'Spec-driven artifact.'}
          </div>
        </div>
        {artifact.contentRef && (
          <div
            title={artifact.contentRef}
            className="max-w-full truncate rounded-md bg-muted/35 px-2 py-1 font-mono text-[10px] text-muted-foreground sm:max-w-[45%] sm:shrink-0"
          >
            {artifact.contentRef}
          </div>
        )}
      </div>

      {stats.length > 0 && (
        <div className="grid grid-cols-2 gap-2 border-b border-border/40 bg-muted/10 px-4 py-3 sm:grid-cols-4">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className={cn(
                'rounded-lg border px-2.5 py-2',
                STAT_TONE_CLASS[stat.tone ?? 'default'],
              )}
            >
              <div className="text-base font-semibold leading-none tabular-nums">{stat.value}</div>
              <div className="mt-1 text-[10px] font-medium uppercase tracking-wide opacity-80">
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="px-4 py-4">
        {content ? (
          <MarkdownRenderer content={content} className={ARTIFACT_MARKDOWN_CLASS} />
        ) : (
          <div className="rounded-lg border border-dashed border-border/50 px-3 py-4 text-xs text-muted-foreground/60">
            No content.
          </div>
        )}
      </div>
    </article>
  )
}

function ArtifactStatusBadge({ status }: { status: TaskArtifact['status'] }) {
  const approved = status === 'approved'
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        approved
          ? 'bg-status-ok/10 text-status-ok'
          : 'bg-status-warn/10 text-status-warn',
      )}
    >
      {status}
    </span>
  )
}

function getArtifactStats(kind: ArtifactKind, content: string): ArtifactStat[] {
  if (!content) return []

  if (kind === 'spec') {
    return visibleStats([
      { label: 'Requirements', value: countMatches(content, /^\s*###\s+Requirement:/gim), tone: 'accent' },
      { label: 'AC', value: countUnique(content, /\{#(AC-\d+)\}/gim), tone: 'success' },
    ])
  }

  if (kind === 'plan') {
    return visibleStats([
      { label: 'Tasks', value: countUnique(content, /\b(T\d{3})\b/gim), tone: 'accent' },
      { label: 'Waves', value: countPlanWaves(content), tone: 'default' },
      { label: 'AC links', value: countUnique(content, /\b(AC-\d+)\b/gim), tone: 'success' },
      { label: 'Files', value: countMatches(content, /(?:^|\s)(?:src|server|web|agent-runtime)\/[^\s`)]+/gim), tone: 'default' },
    ])
  }

  if (kind === 'acceptance') {
    return visibleStats([
      { label: 'AC covered', value: countUnique(content, /\b(AC-\d+)\b/gim), tone: 'success' },
    ])
  }

  return visibleStats([
    { label: 'Requirements', value: countUnique(content, /\{#(REQ-\d+)\}/gim), tone: 'accent' },
  ])
}

function visibleStats(stats: ArtifactStat[]): ArtifactStat[] {
  return stats.filter((stat) => stat.value > 0)
}

/**
 * How many sequential waves the plan executes in — a display-only mirror of the
 * server's `planWaves` (services/sdd/sdd-service.ts), which is the authority.
 * A row is concurrent when it carries `[P]` or a `[C<n>]` group (a coordination
 * group implies parallelism); consecutive concurrent rows share a wave, and every
 * other row is a barrier that runs alone.
 */
function countPlanWaves(content: string): number {
  let waves = 0
  let openConcurrentWave = false
  for (const raw of content.split('\n')) {
    const line = raw.replace(/^\s*[-*]\s*/, '').replace(/^\[[ xX]\]\s*/, '').trim()
    if (!/^(?:T\d+\b|\[T\d+\])/i.test(line)) continue
    const concurrent = /\[(?:P|C\d+)\]/i.test(line)
    if (concurrent && openConcurrentWave) continue
    waves++
    openConcurrentWave = concurrent
  }
  return waves
}

function countMatches(content: string, pattern: RegExp): number {
  return content.match(pattern)?.length ?? 0
}

function countUnique(content: string, pattern: RegExp): number {
  const values = new Set<string>()
  for (const match of content.matchAll(pattern)) {
    const value = match[1]
    if (value) values.add(value.toUpperCase())
  }
  return values.size
}

// ---- Child: subtask context + merge into parent ----

function SubtaskPanel({ task }: { task: SddTask }) {
  const openDetail = useTaskStore((s) => s.openDetail)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const merge = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await api.sddMergeSubtask(task.id)
      if (res.error) setError(res.error)
      else setNotice(`Merged into parent #${res.result?.parentTaskNumber ?? '?'}.`)
    } finally {
      setBusy(false)
    }
  }

  const openParent = () => {
    if (task.parentTaskId == null) return
    setError(null)
    void openDetail(task.parentTaskId).catch(() => {
      setError('Could not open the parent task.')
    })
  }

  return (
    <div className="space-y-3 rounded-xl border border-border/40 bg-muted/10 p-5">
      <div className="flex items-start gap-3">
        <FileText className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
        <div>
          <div className="text-sm font-semibold mb-1">Spec-Driven Subtask</div>
          <div className="text-xs text-muted-foreground">
            {task.planAnchor ? `Plan item ${task.planAnchor}` : 'Plan item'}
            {task.claimedAcs?.length ? ` · owns ${task.claimedAcs.join(', ')}` : ' · owns no AC yet'}.
            The spec/plan live on the parent task.
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
      {notice && <div className="text-xs text-muted-foreground">{notice}</div>}

      <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
        <Button
          size="sm"
          variant="secondary"
          className="h-7 gap-1.5 text-xs"
          onClick={openParent}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
          View parent spec
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-xs"
          disabled={busy}
          onClick={() => void merge()}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitMerge className="h-3.5 w-3.5" />
          )}
          Merge into parent
        </Button>
      </div>
    </div>
  )
}
