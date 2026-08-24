import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  Clock,
  Layers,
  Loader2,
  Plug,
  Power,
  PowerOff,
  Puzzle,
  RefreshCw,
  Sparkles,
  SquareStack,
  StopCircle,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import * as agent from './agentControl'
import type {
  OperonBackgroundTaskDTO,
  OperonCronTaskDTO,
  McpServerDTO,
  OperonPluginDTO,
  OperonSkillDTO,
  OperonSubagentDTO,
} from './agentControl'

interface AgentPanelProps {
  open: boolean
  chatId: number | undefined
  providerId: string | undefined
  onClose: () => void
}

// Keep this in sync with the panel `duration-300` below — it's how long we wait
// after close before unmounting, so the slide-out can finish.
const PANEL_TRANSITION_MS = 300

// Sections whose contents change on their own (connection state, running work)
// re-poll while the panel is open; the static ones only load on open + manual
// refresh. Anything shown here is a *state* readout, so a stale snapshot with a
// pulsing dot on it would be a lie.
const LIVE_POLL_MS = 4000

// `agentControl` answers this when the chat has no runtime session yet — every
// section would show the same error, so we swap the whole body for one message.
const NO_SESSION = /no active session/i

function isMcpProblem(server: McpServerDTO): boolean {
  return (
    server.status === 'failed' ||
    server.status === 'needs-auth' ||
    server.status === 'needs-client-registration'
  )
}

/**
 * Right-side slide-over reading out what this operon session currently has
 * loaded and how it's doing — MCP servers and their connection state, available
 * skills, background tasks, subagents, schedules, plugins.
 *
 * It's an inspector, not an event log: the summary strip answers "is anything
 * wrong / anything running" without expanding a thing, and the sections you're
 * most likely to be asking about start open. Non-modal on purpose — you're
 * meant to keep it up while the agent works. Everything goes through
 * `POST /api/ai/agent-control` via `agentControl.ts`.
 */
export function AgentPanel({ open, chatId, providerId, onClose }: AgentPanelProps) {
  // Two-phase open/close so the panel can animate both IN and OUT:
  //   `render` keeps it mounted a beat longer than `open`, so the slide-out has
  //            time to play before we remove it from the DOM;
  //   `active` drives the on-screen position — it flips on one frame AFTER mount
  //            (so the browser animates from off-screen) and off the moment we close.
  const [render, setRender] = useState(open)
  const [active, setActive] = useState(false)

  // Mount immediately on open; on close, defer the unmount until the exit finishes.
  useEffect(() => {
    if (open) {
      setRender(true)
      return
    }
    const id = setTimeout(() => setRender(false), PANEL_TRANSITION_MS)
    return () => clearTimeout(id)
  }, [open])

  // Slide to on-screen one frame after mounting; slide off-screen as soon as we close.
  useEffect(() => {
    if (open && render) {
      const id = requestAnimationFrame(() => setActive(true))
      return () => cancelAnimationFrame(id)
    }
    if (!open) setActive(false)
  }, [open, render])

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Fetching lives up here rather than per-section so the summary strip, the
  // single refresh control and the no-session check all see the same data.
  const fullSessionInspector = providerId === 'custom'
  const live = open && chatId != null
  const id = chatId ?? -1
  const sessionKey = `${providerId ?? 'none'}:${id}`
  const mcp = usePolled(live, sessionKey, LIVE_POLL_MS, () => agent.mcpList(id))
  const tasks = usePolled(live && fullSessionInspector, sessionKey, LIVE_POLL_MS, () => agent.tasksList(id))
  const subagents = usePolled(live && fullSessionInspector, sessionKey, LIVE_POLL_MS, () => agent.subagentsList(id))
  const skills = usePolled(live && fullSessionInspector, sessionKey, 0, () => agent.skillsList(id))
  const cron = usePolled(live && fullSessionInspector, sessionKey, 0, () => agent.cronList(id))
  // Plugins are global (Settings → Operon), not per-session — chat-less route.
  const plugins = usePolled(open && fullSessionInspector, providerId, 0, async () => {
    const res = await api.pluginsList()
    if (res.error) throw new Error(res.error)
    return res.plugins ?? []
  })

  const servers = mcp.data?.servers ?? []
  const skillList = skills.data?.skills ?? []
  const taskList = tasks.data?.tasks ?? []
  const subagentList = subagents.data?.subagents ?? []
  const cronList = cron.data?.tasks ?? []
  const pluginList = plugins.data ?? []

  const mcpConnected = servers.filter((s) => s.status === 'connected').length
  const mcpProblems = servers.filter(isMcpProblem).length
  const runningTasks = taskList.filter((t) => t.status === 'running').length
  const runningAgents = subagentList.filter((s) => s.status === 'running').length
  const brokenPlugins = pluginList.filter((p) => p.hasErrors).length

  const reloadAll = useCallback(() => {
    mcp.reload()
    if (fullSessionInspector) {
      tasks.reload()
      subagents.reload()
      skills.reload()
      cron.reload()
      plugins.reload()
    }
  }, [fullSessionInspector, mcp, tasks, subagents, skills, cron, plugins])

  const refreshing =
    mcp.loading ||
    (fullSessionInspector &&
      (tasks.loading || subagents.loading || skills.loading || cron.loading || plugins.loading))
  const noSession = chatId == null || (mcp.error != null && NO_SESSION.test(mcp.error))
  const anySettled = mcp.settled || (fullSessionInspector && skills.settled)

  if (!render) return null

  return (
    // Non-modal: no scrim, and the wrapper lets clicks through so the chat
    // underneath stays usable while you watch the session.
    <div className="pointer-events-none absolute inset-0 z-30">
      <div
        className={cn(
          'pointer-events-auto absolute right-0 top-0 flex h-full w-[400px] max-w-[88vw] flex-col border-l border-border/50 bg-background shadow-drawer',
          'transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform',
          active ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex items-center gap-2 border-b border-border/40 px-3.5 py-2.5">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1 text-[13px] font-semibold">Session</span>
          {!noSession && (
            <IconButton onClick={reloadAll} disabled={refreshing} label="Refresh session state">
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </IconButton>
          )}
          <IconButton onClick={onClose} label="Close session panel">
            <X className="h-4 w-4" />
          </IconButton>
        </div>

        {noSession ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 text-center">
            <Layers className="h-5 w-5 text-muted-foreground/50" />
            <div className="text-xs font-medium">No active session</div>
            <div className="text-[11px] text-muted-foreground">
              Send a message to start one — its MCP servers, skills and running work show up here.
            </div>
          </div>
        ) : (
          <>
            {/* Summary strip — the whole point of the panel, readable without expanding anything. */}
            {/* Stays on `background` with the title bar above it — the muted surface
                is reserved for section headers, so it reads as one level, not two. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-3.5 py-2 text-[11px]">
              {!anySettled ? (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading session…
                </span>
              ) : (
                <>
                  <Stat dot={servers.length === 0 ? 'bg-muted-foreground/40' : mcpProblems > 0 ? 'bg-amber-500' : 'bg-emerald-500'}>
                    {mcpConnected}/{servers.length} MCP
                  </Stat>
                  {fullSessionInspector ? (
                    <>
                      <Stat>{skillList.length} skills</Stat>
                      {runningTasks > 0 && <Stat dot="bg-blue-500 animate-pulse">{runningTasks} running</Stat>}
                      {runningAgents > 0 && <Stat dot="bg-blue-500 animate-pulse">{runningAgents} subagents</Stat>}
                      {cronList.length > 0 && <Stat dot="bg-muted-foreground/40">{cronList.length} scheduled</Stat>}
                      {mcpProblems + brokenPlugins > 0 && (
                        <Stat tone="danger" dot="bg-destructive">
                          {mcpProblems + brokenPlugins} need attention
                        </Stat>
                      )}
                    </>
                  ) : mcpProblems > 0 ? (
                    <Stat tone="danger" dot="bg-destructive">
                      {mcpProblems} need attention
                    </Stat>
                  ) : null}
                </>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              <McpSection
                key={sessionKey}
                chatId={id}
                res={mcp}
                canReconnect={providerId !== 'codex'}
                canToggle={providerId === 'claude-code' || providerId === 'opencode'}
              />
              {fullSessionInspector ? (
                <>
                  <SkillsSection res={skills} />
                  <TasksSection chatId={id} res={tasks} />
                  <SubagentsSection res={subagents} />
                  <CronSection chatId={id} res={cron} />
                  <PluginsSection res={plugins} />
                </>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── data hook ────────────────────────────────────────────────────────────────
interface Resource<T> {
  data: T | null
  loading: boolean
  error: string | null
  /** True once a fetch has finished, success or not — lets us tell "empty" from "not loaded yet". */
  settled: boolean
  reload: () => void
}

/**
 * Load `fetcher` when `enabled`, then re-poll every `intervalMs` (0 = never).
 * Poll ticks are silent — they don't flip `loading`, so nothing flickers or
 * disables under you — and the last good data survives a failed poll.
 */
function usePolled<T>(
  enabled: boolean,
  resetKey: unknown,
  intervalMs: number,
  fetcher: () => Promise<T>,
): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState(false)
  // Keep the latest fetcher without making it a reload dependency.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const inFlight = useRef(false)

  const run = useCallback(async (silent: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    if (!silent) setLoading(true)
    try {
      setData(await fetcherRef.current())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSettled(true)
      setLoading(false)
      inFlight.current = false
    }
  }, [])

  const reload = useCallback(() => {
    void run(false)
  }, [run])

  useEffect(() => {
    if (!enabled) return
    setSettled(false)
    void run(false)
    if (intervalMs <= 0) return
    const timer = setInterval(() => {
      // Don't burn requests while the window is in the background.
      if (document.visibilityState === 'hidden') return
      void run(true)
    }, intervalMs)
    return () => clearInterval(timer)
  }, [enabled, resetKey, intervalMs, run])

  return { data, loading, error, settled, reload }
}

// ── primitives ───────────────────────────────────────────────────────────────
function IconButton({
  onClick,
  label,
  disabled,
  children,
}: {
  onClick: () => void
  label: string
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function Dot({ className }: { className: string }) {
  return <span className={cn('inline-block h-1.5 w-1.5 rounded-full shrink-0', className)} />
}

function Stat({ dot, tone, children }: { dot?: string; tone?: 'danger'; children: React.ReactNode }) {
  return (
    <span className={cn('flex items-center gap-1.5 tabular-nums', tone === 'danger' ? 'text-destructive' : 'text-muted-foreground')}>
      {dot && <Dot className={dot} />}
      {children}
    </span>
  )
}

/**
 * Section header badge. Same shape everywhere so the numbers mean the same
 * thing in every section: total on the right, with running / needs-attention
 * counts called out ahead of it when they're non-zero.
 */
function Badge({ total, active, problems }: { total: number; active?: number; problems?: number }) {
  return (
    <span className="flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
      {!!active && (
        <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400">
          <Dot className="bg-blue-500 animate-pulse" />
          {active}
        </span>
      )}
      {!!problems && (
        <span className="flex items-center gap-1 text-destructive">
          <Dot className="bg-destructive" />
          {problems}
        </span>
      )}
      <span className="text-muted-foreground/70">{total}</span>
    </span>
  )
}

function Section({
  icon: Icon,
  title,
  badge,
  expanded,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  badge: React.ReactNode
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <section className="border-b border-border/40 last:border-b-0">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        className={cn(
          // A muted surface is what marks a group — not a heavier font. The rows
          // below stay on `background`, so the contents read as the content and
          // the header reads as a label. Only borders when open, or a collapsed
          // header would double up with the section's own bottom border.
          // The border COLOR stays declared even while collapsed, and only the
          // width toggles below. Tailwind's preflight is `border: 0 solid` with no
          // color, so an undeclared border inherits `currentColor` (near-black
          // foreground) — harmless at 0 width, but `transition-colors` covers
          // border-color, so adding the color and the width together animated a
          // black 1px line fading to grey over 150ms on every expand.
          'sticky top-0 z-10 flex cursor-pointer select-none items-center gap-2 border-border/40 bg-muted/30 px-3.5 py-2 backdrop-blur-sm transition-colors hover:bg-muted/50',
          expanded && 'border-b',
        )}
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform', expanded && 'rotate-90')} />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
        {badge}
      </div>
      {expanded && children}
    </section>
  )
}

/** Loading / error / empty for a section body — never all three at once. */
function StateRow({ res, empty, emptyText }: { res: Resource<unknown>; empty: boolean; emptyText: string }) {
  if (!res.settled)
    return (
      <div className={cn(INDENT, 'flex items-center gap-2 py-2 text-[11px] text-muted-foreground')}>
        <Loader2 className="h-3 w-3 animate-spin" /> Loading…
      </div>
    )
  if (res.error)
    return (
      <div className={cn(INDENT, 'flex items-start gap-2 py-2 text-[11px] text-destructive')}>
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
        <span className="break-words">{res.error}</span>
      </div>
    )
  if (empty) return <div className={cn(INDENT, 'py-2 text-[11px] text-muted-foreground')}>{emptyText}</div>
  return null
}

// Rows indent to their header's icon, so nesting is visible before you read a
// word. The indent lives on the container, which pulls the dividers in with it —
// short lines between rows, full-width lines between sections.
const INDENT = 'pl-9 pr-3.5'
const ROWS = cn(INDENT, 'divide-y divide-border/40')
const ROW = 'py-1.5'

// ── time helpers ─────────────────────────────────────────────────────────────
function relTime(ts: number | null | undefined): string {
  if (ts == null) return '—'
  const diff = ts - Date.now()
  const abs = Math.abs(diff)
  const min = Math.round(abs / 60000)
  const hr = Math.round(abs / 3600000)
  const day = Math.round(abs / 86400000)
  let body: string
  if (abs < 60000) body = 'just now'
  else if (min < 60) body = `${min}m`
  else if (hr < 24) body = `${hr}h`
  else body = `${day}d`
  if (body === 'just now') return body
  return diff >= 0 ? `in ${body}` : `${body} ago`
}

// ── MCP ──────────────────────────────────────────────────────────────────────
// Broken servers sort to the top — with a dozen connected ones you shouldn't
// have to hunt for the one that isn't.
const MCP_RANK: Record<McpServerDTO['status'], number> = {
  failed: 0,
  'needs-auth': 1,
  'needs-client-registration': 2,
  pending: 3,
  connected: 4,
  disabled: 5,
  cancelled: 6,
}

function McpSection({
  chatId,
  res,
  canReconnect,
  canToggle,
}: {
  chatId: number
  res: Resource<{ servers: McpServerDTO[] }>
  canReconnect: boolean
  canToggle: boolean
}) {
  const [expanded, setExpanded] = useState(true)
  const [busyServer, setBusyServer] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const servers = res.data?.servers ?? []
  const sorted = useMemo(
    () => [...servers].sort((a, b) => MCP_RANK[a.status] - MCP_RANK[b.status] || a.name.localeCompare(b.name)),
    [servers],
  )
  const problems = servers.filter(isMcpProblem).length

  const runAction = async (name: string, action: () => Promise<unknown>) => {
    setBusyServer(name)
    setActionError(null)
    try {
      await action()
      res.reload()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyServer(null)
    }
  }

  return (
    <Section
      icon={Plug}
      title="MCP servers"
      badge={<Badge total={servers.length} problems={problems} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <StateRow res={res} empty={servers.length === 0} emptyText="No MCP servers configured." />
      {actionError ? (
        <div className={cn(INDENT, 'flex items-start gap-2 py-2 text-[11px] text-destructive')}>
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-words">{actionError}</span>
        </div>
      ) : null}
      <div className={ROWS}>
        {sorted.map((s) => (
          <McpRow
            key={s.name}
            server={s}
            busy={busyServer === s.name}
            canReconnect={canReconnect}
            canToggle={canToggle}
            onReconnect={() => void runAction(s.name, () => agent.mcpReconnect(chatId, s.name))}
            onToggle={(enabled) => void runAction(s.name, () => agent.mcpToggle(chatId, s.name, enabled))}
          />
        ))}
      </div>
    </Section>
  )
}

const MCP_DOT: Record<McpServerDTO['status'], string> = {
  connected: 'bg-emerald-500',
  'needs-auth': 'bg-amber-500',
  'needs-client-registration': 'bg-amber-500',
  failed: 'bg-red-500',
  pending: 'bg-amber-400 animate-pulse',
  disabled: 'bg-muted-foreground/40',
  cancelled: 'bg-muted-foreground/40',
}

const MCP_STATUS_LABEL: Record<McpServerDTO['status'], string> = {
  connected: 'Connected',
  'needs-auth': 'Needs auth',
  'needs-client-registration': 'Needs registration',
  failed: 'Failed',
  pending: 'Connecting',
  disabled: 'Disabled',
  cancelled: 'Cancelled',
}

function McpRow({
  server,
  busy,
  canReconnect,
  canToggle,
  onReconnect,
  onToggle,
}: {
  server: McpServerDTO
  busy: boolean
  canReconnect: boolean
  canToggle: boolean
  onReconnect: () => void
  onToggle: (enabled: boolean) => void
}) {
  const needsAttention =
    server.status === 'failed' ||
    server.status === 'needs-auth' ||
    server.status === 'needs-client-registration'
  return (
    <div className={ROW}>
      <div className="flex items-center gap-2">
        <Dot className={MCP_DOT[server.status]} />
        <span className="min-w-0 truncate text-xs">{server.name}</span>
        {server.transport && <span className="shrink-0 text-[11px] text-muted-foreground/60">{server.transport}</span>}
        {server.toolCount != null ? (
          <span className="shrink-0 text-[11px] text-muted-foreground/60">{server.toolCount} tools</span>
        ) : null}
        <span className="min-w-0 flex-1" />
        <span className={cn('shrink-0 text-[11px]', needsAttention ? 'text-destructive' : 'text-muted-foreground')}>
          {MCP_STATUS_LABEL[server.status]}
        </span>
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <>
            {canReconnect ? (
              <IconButton
                onClick={onReconnect}
                disabled={server.status === 'disabled' || server.status === 'pending'}
                label={`Reconnect ${server.name}`}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </IconButton>
            ) : null}
            {canToggle ? (
              server.status === 'disabled' ? (
                <IconButton onClick={() => onToggle(true)} label={`Enable ${server.name}`}>
                  <Power className="h-3.5 w-3.5" />
                </IconButton>
              ) : (
                <IconButton onClick={() => onToggle(false)} label={`Disable ${server.name}`}>
                  <PowerOff className="h-3.5 w-3.5" />
                </IconButton>
              )
            ) : null}
          </>
        )}
      </div>
      {server.error && <div className="mt-1 pl-3.5 text-[11px] text-destructive break-words">{server.error}</div>}
    </div>
  )
}

// ── Skills ───────────────────────────────────────────────────────────────────
function SkillsSection({ res }: { res: Resource<{ skills: OperonSkillDTO[] }> }) {
  const [expanded, setExpanded] = useState(true)
  const skills = res.data?.skills ?? []

  return (
    <Section
      icon={Sparkles}
      title="Skills"
      badge={<Badge total={skills.length} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <StateRow res={res} empty={skills.length === 0} emptyText="No skills available." />
      {/* Capped so a long skill list can't push the other sections off-screen. */}
      <div className={cn(ROWS, 'max-h-64 overflow-y-auto')}>
        {skills.map((s) => (
          <div key={s.name} className={ROW} title={s.source}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">/{s.name}</span>
              {s.disableModelInvocation && <span className="shrink-0 text-[11px] text-muted-foreground">manual only</span>}
            </div>
            {s.description && <div className="truncate text-[11px] text-muted-foreground">{s.description}</div>}
          </div>
        ))}
      </div>
    </Section>
  )
}

// ── Background tasks ─────────────────────────────────────────────────────────
function TasksSection({ chatId, res }: { chatId: number; res: Resource<{ tasks: OperonBackgroundTaskDTO[] }> }) {
  const [expanded, setExpanded] = useState(true)
  const tasks = res.data?.tasks ?? []
  const running = tasks.filter((t) => t.status === 'running').length
  const failed = tasks.filter((t) => t.status === 'failed' || t.status === 'timed_out').length
  // Running work first, then most recently started.
  const sorted = useMemo(
    () => [...tasks].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt),
    [tasks],
  )

  return (
    <Section
      icon={SquareStack}
      title="Background tasks"
      badge={<Badge total={tasks.length} active={running} problems={failed} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <StateRow res={res} empty={tasks.length === 0} emptyText="Nothing running in the background." />
      <div className={ROWS}>
        {sorted.map((t) => (
          <TaskRow key={t.taskId} chatId={chatId} task={t} onChanged={res.reload} />
        ))}
      </div>
    </Section>
  )
}

const TASK_DOT: Record<OperonBackgroundTaskDTO['status'], string> = {
  running: 'bg-blue-500 animate-pulse',
  completed: 'bg-emerald-500',
  paused: 'bg-amber-500',
  lost: 'bg-muted-foreground/40',
  failed: 'bg-red-500',
  timed_out: 'bg-red-500',
  killed: 'bg-muted-foreground/40',
}

function TaskRow({ chatId, task, onChanged }: { chatId: number; task: OperonBackgroundTaskDTO; onChanged: () => void }) {
  const [output, setOutput] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const toggleOutput = async () => {
    if (output !== null) {
      setOutput(null)
      return
    }
    setBusy(true)
    try {
      const res = await agent.tasksOutput(chatId, task.taskId)
      setOutput(res.output || '(no output)')
    } catch (err) {
      setOutput(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    try {
      await agent.tasksStop(chatId, task.taskId)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cn(ROW, 'transition-colors hover:bg-muted/20')}>
      <div className="flex items-center gap-2">
        <Dot className={TASK_DOT[task.status]} />
        <button className="min-w-0 flex-1 truncate text-left text-xs" onClick={toggleOutput}>
          {task.description || task.kind}
        </button>
        <span className="shrink-0 text-[11px] text-muted-foreground/70">{task.kind}</span>
        {task.status === 'running' && (
          <IconButton onClick={stop} disabled={busy} label="Stop task">
            <StopCircle className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      {busy && output === null && <div className="mt-1 pl-3.5 text-[11px] text-muted-foreground">Loading output…</div>}
      {output !== null && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-[11px] leading-relaxed">
          {output}
        </pre>
      )}
    </div>
  )
}

// ── Subagents ────────────────────────────────────────────────────────────────
const SUBAGENT_DOT: Record<OperonSubagentDTO['status'], string> = {
  running: 'bg-blue-500 animate-pulse',
  completed: 'bg-emerald-500',
  paused: 'bg-amber-500',
  lost: 'bg-muted-foreground/40',
  cancelled: 'bg-muted-foreground/40',
  error: 'bg-red-500',
}

function SubagentsSection({ res }: { res: Resource<{ subagents: OperonSubagentDTO[] }> }) {
  const [expanded, setExpanded] = useState(false)
  const subagents = res.data?.subagents ?? []
  const running = subagents.filter((s) => s.status === 'running').length
  const errored = subagents.filter((s) => s.status === 'error').length

  return (
    <Section
      icon={Users}
      title="Subagents"
      badge={<Badge total={subagents.length} active={running} problems={errored} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <StateRow res={res} empty={subagents.length === 0} emptyText="No delegated agents." />
      <div className={ROWS}>
        {subagents.map((s) => (
          <div key={s.agentId} className={ROW}>
            <div className="flex items-center gap-2">
              <Dot className={SUBAGENT_DOT[s.status]} />
              <span className="min-w-0 flex-1 truncate text-xs">{s.type}</span>
              <span className="max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground/70">{s.address}</span>
            </div>
            {s.description && <div className="truncate pl-3.5 text-[11px] text-muted-foreground">{s.description}</div>}
          </div>
        ))}
      </div>
    </Section>
  )
}

// ── Cron ─────────────────────────────────────────────────────────────────────
function CronSection({ chatId, res }: { chatId: number; res: Resource<{ tasks: OperonCronTaskDTO[] }> }) {
  const [expanded, setExpanded] = useState(false)
  const tasks = res.data?.tasks ?? []
  const [adding, setAdding] = useState(false)
  const [cron, setCron] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    if (!cron.trim() || !prompt.trim()) return
    setBusy(true)
    try {
      await agent.cronCreate(chatId, { cron: cron.trim(), prompt: prompt.trim() })
      setCron('')
      setPrompt('')
      setAdding(false)
      res.reload()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    await agent.cronDelete(chatId, id)
    res.reload()
  }

  return (
    <Section
      icon={Clock}
      title="Scheduled runs"
      badge={<Badge total={tasks.length} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <StateRow res={res} empty={tasks.length === 0} emptyText="No scheduled runs." />
      <div className={ROWS}>
        {tasks.map((t) => (
          <div key={t.id} className={ROW}>
            <div className="flex items-center gap-2">
              <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{t.cron}</code>
              <span className="flex-1 text-[11px] text-muted-foreground">next {relTime(t.nextFireAt)}</span>
              <IconButton onClick={() => remove(t.id)} label="Delete schedule">
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </div>
            <div className="mt-0.5 line-clamp-2 text-xs">{t.prompt}</div>
          </div>
        ))}
      </div>
      <div className={cn(INDENT, 'pb-2 pt-1.5')}>
        {adding ? (
          <div className="space-y-2">
            <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="Cron, e.g. 0 9 * * *" className="h-7 border-border/50 text-xs" />
            <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Prompt to run" className="h-7 border-border/50 text-xs" />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" className="h-7 gap-1.5 text-xs" onClick={create} disabled={busy || !cron.trim() || !prompt.trim()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Create
              </Button>
              <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => setAdding(true)}>
            + New schedule
          </Button>
        )}
      </div>
    </Section>
  )
}

// ── Plugins (read-only) ──────────────────────────────────────────────────────
// Session-independent: plugins are installed/enabled globally in Settings → Operon.
// This is just a readout of what's active for the agent right now.
function PluginsSection({ res }: { res: Resource<OperonPluginDTO[]> }) {
  const [expanded, setExpanded] = useState(false)
  const plugins = res.data ?? []
  const broken = plugins.filter((p) => p.hasErrors).length

  return (
    <Section
      icon={Puzzle}
      title="Plugins"
      badge={<Badge total={plugins.length} problems={broken} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <StateRow res={res} empty={plugins.length === 0} emptyText="No plugins installed." />
      <div className={ROWS}>
        {plugins.map((p) => (
          <div key={p.id} className={ROW}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs">{p.displayName}</span>
              {!p.enabled && <span className="shrink-0 text-[11px] text-muted-foreground">disabled</span>}
              {p.hasErrors && <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {p.skillCount} skills · {p.enabledMcpServerCount}/{p.mcpServerCount} MCP
            </div>
          </div>
        ))}
      </div>
      {plugins.length > 0 && (
        <div className={cn(INDENT, 'pb-2 pt-1.5 text-[11px] text-muted-foreground/70')}>Manage in Settings → Operon.</div>
      )}
    </Section>
  )
}
