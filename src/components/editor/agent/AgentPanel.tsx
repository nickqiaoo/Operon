import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  Clock,
  ExternalLink,
  Layers,
  Loader2,
  MessageSquare,
  Plug,
  Power,
  PowerOff,
  Puzzle,
  Blocks,
  RefreshCw,
  Sparkles,
  SquareStack,
  StopCircle,
  Trash2,
  Users,
  UsersRound,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FormattedMessage, useIntl } from 'react-intl'
import { cn } from '@/lib/utils'
import { openExternalUrl } from '@/lib/open-external'
import { openSettingsTab } from '@/lib/open-settings'
import { api } from '@/lib/api'
import { useEditorStore } from '@/stores/editor-store'
import type { PeerMemberDTO, PeerMemberStatus, PeersRosterDTO, PeersStatsDTO, PeerTeamDTO } from '@/types/peers'
import * as agent from './agentControl'
import { SkillDetail } from './SkillDetail'
import { DisbandConfirmDialog } from './DisbandConfirmDialog'
import type {
  OperonBackgroundTaskDTO,
  OperonCronTaskDTO,
  McpServerDTO,
  McpToolDTO,
  OperonPluginDTO,
  OperonSessionExtensionDTO,
  OperonSkillDTO,
  OperonSubagentDTO,
} from './agentControl'

interface AgentPanelProps {
  open: boolean
  chatId: number | undefined
  providerId: string | undefined
  onClose: () => void
  /** Add a skill to the composer as a chip — how a skill row hands itself over. */
  onUseSkill?: (skill: OperonSkillDTO) => void
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
export function AgentPanel({ open, chatId, providerId, onClose, onUseSkill }: AgentPanelProps) {
  const intl = useIntl()
  // Two-phase open/close so the panel can animate both IN and OUT:
  //   `render` keeps it mounted a beat longer than `open`, so the slide-out has
  //            time to play before we remove it from the DOM;
  //   `active` drives the on-screen position — it flips on one frame AFTER mount
  //            (so the browser animates from off-screen) and off the moment we close.
  const [render, setRender] = useState(open)
  const [active, setActive] = useState(false)
  /** The panel's second layer: a skill read out in full. `null` = the list. */
  const [skillDetail, setSkillDetail] = useState<OperonSkillDTO | null>(null)

  // Mount immediately on open; on close, defer the unmount until the exit finishes.
  useEffect(() => {
    if (open) {
      setRender(true)
      return
    }
    setSkillDetail(null)
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
  const extensions = usePolled(live && fullSessionInspector, sessionKey, 0, () => agent.extensionsList(id))
  // The roster changes on its own (teammates wake, finish, park) — live poll.
  const peers = usePolled(live && fullSessionInspector, sessionKey, LIVE_POLL_MS, () => agent.peersList(id))
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
  const teamMembers = peers.data?.teams.flatMap((t) => t.members) ?? []
  const runningMembers = teamMembers.filter((m) => m.status === 'running').length
  const blockedMembers = teamMembers.filter((m) => m.pendingApprovals > 0 || m.status === 'error').length
  const teamPaused = peers.data?.stats?.exceeded != null

  const reloadAll = useCallback(() => {
    mcp.reload()
    if (fullSessionInspector) {
      tasks.reload()
      subagents.reload()
      skills.reload()
      cron.reload()
      plugins.reload()
      extensions.reload()
      peers.reload()
    }
  }, [fullSessionInspector, mcp, tasks, subagents, skills, cron, plugins, extensions, peers])

  const refreshing =
    mcp.loading ||
    (fullSessionInspector &&
      (tasks.loading || subagents.loading || skills.loading || cron.loading || plugins.loading || extensions.loading || peers.loading))
  const noSession = chatId == null || (mcp.error != null && NO_SESSION.test(mcp.error))
  const anySettled = mcp.settled || (fullSessionInspector && skills.settled)

  if (!render) return null

  return (
    // Non-modal: no scrim, and the wrapper lets clicks through so the chat
    // underneath stays usable while you watch the session.
    <div className="pointer-events-none absolute inset-0 z-30">
      <div
        className={cn(
          'pointer-events-auto absolute right-0 top-0 flex h-full w-[400px] max-w-[88vw] flex-col border-l border-border/50 bg-sidebar shadow-drawer',
          'transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform',
          active ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
          <Layers className="h-3.5 w-3.5 text-muted-foreground/70" />
          <span className="flex-1 text-[13px] font-semibold tracking-tight"><FormattedMessage id="editor.session.title" defaultMessage="Session" /></span>
          {!noSession && (
            <IconButton onClick={reloadAll} disabled={refreshing} label={intl.formatMessage({ id: 'editor.session.refresh', defaultMessage: 'Refresh session state' })}>
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </IconButton>
          )}
          <IconButton onClick={onClose} label={intl.formatMessage({ id: 'editor.session.close', defaultMessage: 'Close session panel' })}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>

        {skillDetail ? (
          <SkillDetail
            skill={skillDetail}
            onBack={() => setSkillDetail(null)}
            onUse={() => {
              onUseSkill?.(skillDetail)
              setSkillDetail(null)
            }}
          />
        ) : noSession ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 text-center">
            <Layers className="h-5 w-5 text-muted-foreground/50" />
            <div className="text-xs font-medium"><FormattedMessage id="editor.session.none" defaultMessage="No active session" /></div>
            <div className="text-[11px] text-muted-foreground">
              <FormattedMessage
                id="editor.session.noneHint"
                defaultMessage="Send a message to start one — its MCP servers, skills and running work show up here."
              />
            </div>
          </div>
        ) : (
          <>
            {/* Summary strip — the whole point of the panel, readable without expanding anything. */}
            {/* Stays on `background` with the title bar above it — the muted surface
                is reserved for section headers, so it reads as one level, not two. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-3 py-2 text-xs">
              {!anySettled ? (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading session…
                </span>
              ) : (
                <>
                  <Stat dot={servers.length === 0 ? 'bg-muted-foreground/40' : mcpProblems > 0 ? 'bg-status-warn' : 'bg-status-ok/70'}>
                    {mcpConnected}/{servers.length} MCP
                  </Stat>
                  {fullSessionInspector ? (
                    <>
                      <Stat><FormattedMessage id="editor.session.stat.skills" defaultMessage="{count, plural, one {# skill} other {# skills}}" values={{ count: skillList.length }} /></Stat>
                      {runningTasks > 0 && <Stat dot="bg-status-info animate-pulse"><FormattedMessage id="editor.session.stat.running" defaultMessage="{count} running" values={{ count: runningTasks }} /></Stat>}
                      {runningAgents > 0 && <Stat dot="bg-status-info animate-pulse"><FormattedMessage id="editor.session.stat.subagents" defaultMessage="{count, plural, one {# subagent} other {# subagents}}" values={{ count: runningAgents }} /></Stat>}
                      {runningMembers > 0 && <Stat dot="bg-status-info animate-pulse"><FormattedMessage id="editor.session.stat.teammates" defaultMessage="{count, plural, one {# teammate} other {# teammates}} working" values={{ count: runningMembers }} /></Stat>}
                      {teamPaused && <Stat dot="bg-status-warn"><FormattedMessage id="editor.session.stat.teamPaused" defaultMessage="team paused" /></Stat>}
                      {cronList.length > 0 && <Stat dot="bg-muted-foreground/40"><FormattedMessage id="editor.session.stat.scheduled" defaultMessage="{count} scheduled" values={{ count: cronList.length }} /></Stat>}
                      {mcpProblems + brokenPlugins + blockedMembers > 0 && (
                        <Stat tone="danger" dot="bg-destructive">
                          <FormattedMessage id="editor.session.stat.attention" defaultMessage="{count} need attention" values={{ count: mcpProblems + brokenPlugins + blockedMembers }} />
                        </Stat>
                      )}
                    </>
                  ) : mcpProblems > 0 ? (
                    <Stat tone="danger" dot="bg-destructive">
                      <FormattedMessage id="editor.session.stat.attention" defaultMessage="{count} need attention" values={{ count: mcpProblems }} />
                    </Stat>
                  ) : null}
                </>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              {/* NOW — what this session is doing. Sections with nothing in them are not
                  rendered at all: a header plus "nothing running" is a whole row spent
                  saying there is nothing to see, and three of those in a row (tasks,
                  subagents, schedules) is most of a screen. MCP is the exception — a
                  session's servers are worth a glance even when all is well. */}
              {fullSessionInspector && <GroupHeader label={<FormattedMessage id="editor.session.now" defaultMessage="Now" />} />}
              <McpSection
                key={sessionKey}
                chatId={id}
                res={mcp}
                canReconnect={providerId !== 'codex'}
                canToggle={providerId === 'claude-code' || providerId === 'opencode'}
              />
              {fullSessionInspector ? (
                <>
                  {/* Hide only once we KNOW it is empty — a section that vanishes the
                      moment its first poll returns would flicker on every open. A team
                      with no teammates yet still shows: the team itself is the news. */}
                  {(!peers.settled || (peers.data?.teams.length ?? 0) > 0) && <TeamSection res={peers} />}
                  {(!tasks.settled || taskList.length > 0) && <TasksSection chatId={id} res={tasks} />}
                  {(!subagents.settled || subagentList.length > 0) && <SubagentsSection res={subagents} />}
                  <CronSection chatId={id} res={cron} />
                  {/* CAPABILITIES — what it CAN do. Static, global, and mostly managed
                      elsewhere, so it sits below the live half and starts collapsed. */}
                  <GroupHeader label={<FormattedMessage id="editor.session.capabilities" defaultMessage="Capabilities" />} />
                  <SkillsSection res={skills} onSelect={setSkillDetail} />
                  <PluginsSection res={plugins} />
                  <ExtensionsSection res={extensions} />
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
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-secondary-hover hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function Dot({ className }: { className: string }) {
  return <span className={cn('inline-block h-1.5 w-1.5 rounded-full shrink-0', className)} />
}

/**
 * A status dot parked in the row's left indent, so rows with one line up with rows
 * without. `w-0` keeps it out of the flex flow entirely; the dot itself is drawn to
 * the left of where the text starts.
 */
function RowDot({ className }: { className: string | null }) {
  return (
    <span className="relative w-0 shrink-0" aria-hidden>
      {className && <span className={cn('absolute -left-3.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full', className)} />}
    </span>
  )
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
        <span className="flex items-center gap-1 text-status-info">
          <Dot className="bg-status-info animate-pulse" />
          {active}
        </span>
      )}
      {!!problems && (
        <span className="flex items-center gap-1 text-status-error">
          <Dot className="bg-status-error" />
          {problems}
        </span>
      )}
      <span className="text-muted-foreground/45">{total}</span>
    </span>
  )
}

/**
 * Splits the panel in two: what is happening now, and what this session is able to do.
 *
 * They were one flat list of eight identical headers, which made a teammate blocked on an
 * approval look exactly as urgent as the count of installed plugins. The line is drawn by
 * lifetime: the top half changes while you watch, the bottom half changes when you go and
 * change it.
 */
function GroupHeader({ label }: { label: React.ReactNode }) {
  return (
    // Uppercase + letterspacing is what separates this tier from the section labels
    // below it, which are sentence-case and darker. Two tiers of grey uppercase text
    // would read as one.
    <div className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/45">
      {label}
    </div>
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
  title: React.ReactNode
  badge: React.ReactNode
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <section className="pb-2">
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
          // No fill. A grey bar per section made the labels weigh as much as the
          // content under them — eight identical bars down the column, each one
          // competing with the rows it was supposed to introduce. The header earns
          // its place by being SMALLER and quieter than the content instead, which
          // is also why it can stay sticky without dominating: it reads as a margin
          // note, not as a lid on a box. Fill is reserved for hover.
          'sticky top-0 z-10 flex cursor-pointer select-none items-center gap-2 bg-sidebar px-3 py-1.5 transition-colors hover:bg-secondary-hover',
        )}
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground/40 transition-transform', expanded && 'rotate-90')} />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span className="flex-1 truncate text-[13px] font-medium text-foreground/75">{title}</span>
        {badge}
      </div>
      {expanded && children}
    </section>
  )
}

/** Loading / error / empty for a section body — never all three at once. */
function StateRow({ res, empty, emptyText }: { res: Resource<unknown>; empty: boolean; emptyText: React.ReactNode }) {
  if (!res.settled)
    return (
      <div className={cn(INDENT, 'flex items-center gap-2 py-1.5 text-xs text-muted-foreground/70')}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
      </div>
    )
  if (res.error)
    return (
      <div className={cn(INDENT, 'flex items-start gap-2 py-1.5 text-xs text-status-error')}>
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
        <span className="break-words">{res.error}</span>
      </div>
    )
  if (empty) return <div className={cn(INDENT, 'py-1.5 text-xs text-muted-foreground/70')}>{emptyText}</div>
  return null
}

// Rows indent to their header's icon, so nesting is visible before you read a word.
//
// No rule between rows. A divider per row plus a bordered header per section put a
// line every ~28px down a 400px column, which reads as a table of contents for a
// table of contents; the indent already says "these belong to that", and rows this
// tight do not need help staying apart. Lines are kept for the one boundary that
// carries meaning: between sections.
const INDENT = 'pl-8 pr-3'
const ROWS = INDENT
// An inspector should be dense — you scan it, you don't read it. 24px rows put the
// whole session on one screen, which is the difference between glancing and scrolling.
const ROW = 'py-[3px] text-sm leading-5'

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
      title={<FormattedMessage id="editor.session.mcp" defaultMessage="MCP servers" />}
      badge={<Badge total={servers.length} problems={problems} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <StateRow res={res} empty={servers.length === 0} emptyText={<FormattedMessage id="editor.session.mcpEmpty" defaultMessage="No MCP servers configured." />} />
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
            chatId={chatId}
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

/**
 * A dot per status — `null` where the status is the boring one.
 *
 * Six saturated green dots in a column were the loudest thing in the panel, and they
 * were saying "everything is fine". Colour has to be scarce to mean anything: with
 * healthy servers silent, the one amber dot in a list of six is impossible to miss,
 * which is the only time you actually needed to look.
 */
const MCP_DOT: Record<McpServerDTO['status'], string | null> = {
  connected: null,
  'needs-auth': 'bg-status-warn',
  'needs-client-registration': 'bg-status-warn',
  failed: 'bg-status-error',
  pending: 'bg-status-warn animate-pulse',
  disabled: 'bg-muted-foreground/40',
  cancelled: 'bg-muted-foreground/40',
}

/** Message id per status. Only shown for statuses that need you to do something —
 *  `connected` never renders, but it stays in the map so the record is exhaustive. */
const MCP_STATUS_LABEL: Record<McpServerDTO['status'], { id: string; defaultMessage: string }> = {
  connected: { id: 'editor.session.mcpStatus.connected', defaultMessage: 'Connected' },
  'needs-auth': { id: 'editor.session.mcpStatus.needsAuth', defaultMessage: 'Needs auth' },
  'needs-client-registration': { id: 'editor.session.mcpStatus.needsRegistration', defaultMessage: 'Needs registration' },
  failed: { id: 'editor.session.mcpStatus.failed', defaultMessage: 'Failed' },
  pending: { id: 'editor.session.mcpStatus.pending', defaultMessage: 'Connecting' },
  disabled: { id: 'editor.session.mcpStatus.disabled', defaultMessage: 'Disabled' },
  cancelled: { id: 'editor.session.mcpStatus.cancelled', defaultMessage: 'Cancelled' },
}

/**
 * A server's tools, fetched the first time you open the row.
 *
 * Not part of `mcp.list`: listing tools is a round trip to each server, and the panel
 * polls its list every few seconds — paying for six servers' tool lists on every tick,
 * to render something nobody has asked to see, is the kind of cost that makes a panel
 * feel heavy. Asked for once, then kept.
 */
function useMcpTools(chatId: number, name: string, enabled: boolean) {
  const [tools, setTools] = useState<McpToolDTO[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || tools != null) return
    let cancelled = false
    agent
      .mcpTools(chatId, name)
      .then((r) => !cancelled && setTools(r.tools))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [chatId, name, enabled, tools])

  return { tools, error }
}

function McpRow({
  chatId,
  server,
  busy,
  canReconnect,
  canToggle,
  onReconnect,
  onToggle,
}: {
  chatId: number
  server: McpServerDTO
  busy: boolean
  canReconnect: boolean
  canToggle: boolean
  onReconnect: () => void
  onToggle: (enabled: boolean) => void
}) {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const { tools, error: toolsError } = useMcpTools(chatId, server.name, open)
  const needsAttention =
    server.status === 'failed' ||
    server.status === 'needs-auth' ||
    server.status === 'needs-client-registration'
  const dot = MCP_DOT[server.status]
  return (
    // `group` so the row's controls can stay hidden until you point at it. Six copies
    // of the same refresh icon down the right edge read as decoration, not as buttons,
    // and they made every row look busy while nothing was happening.
    <div className={cn(ROW, 'group -mx-1 rounded px-1 hover:bg-secondary-hover')}>
      <div className="flex h-5 items-center gap-2">
        <RowDot className={dot} />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={server.status !== 'connected'}
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
        >
          <span className="min-w-0 truncate">{server.name}</span>
          {server.transport && <span className="shrink-0 text-[11px] text-muted-foreground/50">{server.transport}</span>}
          {server.status === 'connected' && (
            <ChevronRight
              className={cn(
                'h-3 w-3 shrink-0 text-muted-foreground/40 transition-[transform,opacity]',
                open ? 'rotate-90 opacity-100' : 'opacity-0 group-hover:opacity-100',
              )}
            />
          )}
        </button>
        {/* "Connected" six times over is noise; a status only earns words when it
            is one you have to do something about. */}
        {server.status !== 'connected' && (
          <span className={cn('shrink-0 text-[11px]', needsAttention ? 'text-status-error' : 'text-muted-foreground')}>
            <FormattedMessage {...MCP_STATUS_LABEL[server.status]} />
          </span>
        )}
        {busy ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {canReconnect ? (
              <IconButton
                onClick={onReconnect}
                disabled={server.status === 'disabled' || server.status === 'pending'}
                label={intl.formatMessage({ id: 'editor.session.reconnect', defaultMessage: 'Reconnect {name}' }, { name: server.name })}
              >
                <RefreshCw className="h-3 w-3" />
              </IconButton>
            ) : null}
            {canToggle ? (
              server.status === 'disabled' ? (
                <IconButton onClick={() => onToggle(true)} label={intl.formatMessage({ id: 'editor.session.enable', defaultMessage: 'Enable {name}' }, { name: server.name })}>
                  <Power className="h-3 w-3" />
                </IconButton>
              ) : (
                <IconButton onClick={() => onToggle(false)} label={intl.formatMessage({ id: 'editor.session.disable', defaultMessage: 'Disable {name}' }, { name: server.name })}>
                  <PowerOff className="h-3 w-3" />
                </IconButton>
              )
            ) : null}
          </span>
        )}
      </div>
      {server.error && <div className="pb-1 pl-3.5 text-[11px] text-status-error break-words">{server.error}</div>}
      {open && (
        <div className="pb-1 pl-3.5">
          {toolsError ? (
            <div className="py-0.5 text-[11px] text-status-error">{toolsError}</div>
          ) : tools == null ? (
            <div className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground/70">
              <Loader2 className="h-3 w-3 animate-spin" />{' '}
              <FormattedMessage id="editor.session.loadingTools" defaultMessage="Loading tools…" />
            </div>
          ) : tools.length === 0 ? (
            <div className="py-0.5 text-[11px] text-muted-foreground/70"><FormattedMessage id="editor.session.noTools" defaultMessage="No tools." /></div>
          ) : (
            tools.map((t) => (
              <div key={t.name} className="flex items-baseline gap-2 py-px" title={t.description}>
                <span className="min-w-0 truncate text-xs text-foreground/70">{t.name}</span>
                {t.description && (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/45">{t.description}</span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ── Skills ───────────────────────────────────────────────────────────────────
/**
 * The skills this session can reach — one line each, and each line opens the skill.
 *
 * The description used to sit under every name, which cost a second line per skill (the
 * list ran past the height of the panel and had to grow its own scrollbar) and still
 * showed only a truncated sentence. It moves to the row's tooltip and to the detail
 * view, where there is room to read the whole file.
 */
function SkillsSection({ res, onSelect }: { res: Resource<{ skills: OperonSkillDTO[] }>; onSelect: (skill: OperonSkillDTO) => void }) {
  const [expanded, setExpanded] = useState(false)
  const skills = res.data?.skills ?? []

  return (
    <Section
      icon={Sparkles}
      title={<FormattedMessage id="editor.session.skills" defaultMessage="Skills" />}
      badge={<Badge total={skills.length} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <StateRow res={res} empty={skills.length === 0} emptyText={<FormattedMessage id="editor.session.skillsEmpty" defaultMessage="No skills available." />} />
      {/* Capped so a long skill list can't push the other sections off-screen. */}
      <div className={cn(ROWS, 'max-h-64 overflow-y-auto')}>
        {skills.map((s) => (
          <button
            key={s.name}
            type="button"
            onClick={() => onSelect(s)}
            title={s.description || s.source}
            className={cn(ROW, 'group -mx-1 flex w-full items-center gap-2 rounded px-1 text-left hover:bg-secondary-hover')}
          >
            <span className="min-w-0 flex-1 truncate text-foreground/85">/{s.name}</span>
            {s.disableModelInvocation && <span className="shrink-0 text-[11px] text-muted-foreground/60"><FormattedMessage id="editor.session.manualOnly" defaultMessage="manual" /></span>}
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
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
      title={<FormattedMessage id="editor.session.tasks" defaultMessage="Background tasks" />}
      badge={<Badge total={tasks.length} active={running} problems={failed} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <StateRow res={res} empty={tasks.length === 0} emptyText={<FormattedMessage id="editor.session.tasksEmpty" defaultMessage="Nothing running in the background." />} />
      <div className={ROWS}>
        {sorted.map((t) => (
          <TaskRow key={t.taskId} chatId={chatId} task={t} onChanged={res.reload} />
        ))}
      </div>
    </Section>
  )
}

const TASK_DOT: Record<OperonBackgroundTaskDTO['status'], string> = {
  running: 'bg-status-info animate-pulse',
  completed: 'bg-status-ok/70',
  paused: 'bg-status-warn',
  lost: 'bg-muted-foreground/30',
  failed: 'bg-status-error',
  timed_out: 'bg-status-error',
  killed: 'bg-muted-foreground/30',
}

function TaskRow({ chatId, task, onChanged }: { chatId: number; task: OperonBackgroundTaskDTO; onChanged: () => void }) {
  const intl = useIntl()
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
        <RowDot className={TASK_DOT[task.status]} />
        <button className="min-w-0 flex-1 truncate text-left text-foreground/85" onClick={toggleOutput}>
          {task.description || task.kind}
        </button>
        <span className="shrink-0 text-[11px] text-muted-foreground/50">{task.kind}</span>
        {task.status === 'running' && (
          <IconButton onClick={stop} disabled={busy} label={intl.formatMessage({ id: 'editor.session.stopTask', defaultMessage: 'Stop task' })}>
            <StopCircle className="h-3 w-3" />
          </IconButton>
        )}
      </div>
      {busy && output === null && <div className="mt-1 pl-3.5 text-[11px] text-muted-foreground"><FormattedMessage id="editor.session.loadingOutput" defaultMessage="Loading output…" /></div>}
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
  running: 'bg-status-info animate-pulse',
  completed: 'bg-status-ok/70',
  paused: 'bg-status-warn',
  lost: 'bg-muted-foreground/30',
  cancelled: 'bg-muted-foreground/30',
  error: 'bg-status-error',
}

function SubagentsSection({ res }: { res: Resource<{ subagents: OperonSubagentDTO[] }> }) {
  // Only rendered when there ARE subagents now, so collapsed would hide the one thing
  // you opened it for.
  const [expanded, setExpanded] = useState(true)
  const subagents = res.data?.subagents ?? []
  const running = subagents.filter((s) => s.status === 'running').length
  const errored = subagents.filter((s) => s.status === 'error').length

  return (
    <Section
      icon={Users}
      title={<FormattedMessage id="editor.session.subagents" defaultMessage="Subagents" />}
      badge={<Badge total={subagents.length} active={running} problems={errored} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <StateRow res={res} empty={subagents.length === 0} emptyText={<FormattedMessage id="editor.session.subagentsEmpty" defaultMessage="No delegated agents." />} />
      <div className={ROWS}>
        {subagents.map((s) => (
          <div key={s.agentId} className={cn(ROW, '-mx-1 rounded px-1')} title={s.description || s.address}>
            <div className="flex h-5 items-center gap-2">
              <RowDot className={SUBAGENT_DOT[s.status]} />
              <span className="min-w-0 flex-1 truncate text-foreground/85">{s.type}</span>
              <span className="max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground/50">{s.address}</span>
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

// ── Cron ─────────────────────────────────────────────────────────────────────
function CronSection({ chatId, res }: { chatId: number; res: Resource<{ tasks: OperonCronTaskDTO[] }> }) {
  const intl = useIntl()
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
      title={<FormattedMessage id="editor.session.cron" defaultMessage="Scheduled runs" />}
      badge={<Badge total={tasks.length} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <StateRow res={res} empty={tasks.length === 0} emptyText={<FormattedMessage id="editor.session.cronEmpty" defaultMessage="No scheduled runs." />} />
      <div className={ROWS}>
        {tasks.map((t) => (
          <div key={t.id} className={ROW}>
            <div className="flex items-center gap-2">
              <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{t.cron}</code>
              <span className="flex-1 text-[11px] text-muted-foreground">next {relTime(t.nextFireAt)}</span>
              <IconButton onClick={() => remove(t.id)} label={intl.formatMessage({ id: 'editor.session.deleteSchedule', defaultMessage: 'Delete schedule' })}>
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
            <Input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder={intl.formatMessage({ id: 'editor.session.cronPlaceholder', defaultMessage: 'Cron, e.g. 0 9 * * *' })}
              className="h-7 border-border/50 text-xs"
            />
            <Input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={intl.formatMessage({ id: 'editor.session.promptPlaceholder', defaultMessage: 'Prompt to run' })}
              className="h-7 border-border/50 text-xs"
            />
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
      title={<FormattedMessage id="editor.session.plugins" defaultMessage="Plugins" />}
      badge={<Badge total={plugins.length} problems={broken} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <StateRow res={res} empty={plugins.length === 0} emptyText={<FormattedMessage id="editor.session.pluginsEmpty" defaultMessage="No plugins installed." />} />
      <div className={ROWS}>
        {plugins.map((p) => (
          <button
            key={p.id}
            type="button"
            // A github-installed plugin has a repo worth reading; everything else is
            // managed in one place, so send those rows there rather than nowhere.
            onClick={() =>
              p.github
                ? openExternalUrl(`https://github.com/${p.github.owner}/${p.github.repo}`)
                : openSettingsTab('plugins')
            }
            title={p.originalSource ?? p.source}
            className={cn(ROW, 'group -mx-1 flex w-full items-center gap-2 rounded px-1 text-left hover:bg-secondary-hover')}
          >
            <span className="min-w-0 flex-1 truncate text-foreground/85">{p.displayName}</span>
            {/* The counts sit on the same line as the name now. As a second line they
                doubled every plugin's height to carry two numbers nobody scans. */}
            <span className="shrink-0 text-xs text-muted-foreground/50 tabular-nums">
              <FormattedMessage
                id="editor.session.pluginCounts"
                defaultMessage="{skills, plural, one {# skill} other {# skills}} · {enabled}/{total} MCP"
                values={{ skills: p.skillCount, enabled: p.enabledMcpServerCount, total: p.mcpServerCount }}
              />
            </span>
            {!p.enabled && <span className="shrink-0 text-[11px] text-muted-foreground/60"><FormattedMessage id="editor.session.disabled" defaultMessage="disabled" /></span>}
            {p.hasErrors && <AlertTriangle className="h-3 w-3 shrink-0 text-status-warn" />}
            {p.github ? (
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
            )}
          </button>
        ))}
      </div>
      <SettingsLink tab="plugins" label={<FormattedMessage id="editor.session.managePlugins" defaultMessage="Manage plugins in Settings" />} />
    </Section>
  )
}

// ── Team ─────────────────────────────────────────────────────────────────────
const MEMBER_DOT: Record<PeerMemberStatus, string> = {
  running: 'bg-status-info animate-pulse',
  // Idle is a teammate waiting, not a teammate healthy — it does not need a colour.
  idle: 'bg-muted-foreground/40',
  parked: 'bg-muted-foreground/25',
  error: 'bg-status-error',
}

/** Open a teammate's conversation as an editor tab — the same path the history popover takes. */
function openMemberChat(member: PeerMemberDTO): void {
  if (member.chatId == null) return
  const tabId = `chat:${member.chatId}`
  const store = useEditorStore.getState()
  store.openChatTab(tabId, `${member.name} · ${member.typeTitle}`, undefined, 'custom')
  store.setTabChatId(tabId, member.chatId)
}

/**
 * Teams this session created: every teammate with its status, plus the fleet budget.
 * Teammates are independent sessions, so a row opens that teammate's own chat — read it,
 * or type into it to steer.
 */
function TeamSection({ res }: { res: Resource<PeersRosterDTO> }) {
  const intl = useIntl()
  const [expanded, setExpanded] = useState(true)
  /** Team awaiting a disband confirmation; `null` = no dialog. */
  const [confirming, setConfirming] = useState<PeerTeamDTO | null>(null)
  const roster = res.data
  const members = roster?.teams.flatMap((t) => t.members) ?? []
  const running = members.filter((m) => m.status === 'running').length
  const problems = members.filter((m) => m.status === 'error' || m.pendingApprovals > 0).length
  const stats = roster?.stats ?? null

  const wakePct = stats?.budget.maxWakes ? Math.min(100, Math.round((stats.totals.wakes / stats.budget.maxWakes) * 100)) : null
  const tokenPct = stats?.budget.maxTotalTokens ? Math.min(100, Math.round((stats.totals.totalTokens / stats.budget.maxTotalTokens) * 100)) : null

  return (
    <Section
      icon={UsersRound}
      title={<FormattedMessage id="editor.session.team" defaultMessage="Team" />}
      badge={<Badge total={members.length} active={running} problems={problems} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <StateRow res={res} empty={false} emptyText="" />
      {roster && !roster.available ? (
        <div className={cn(INDENT, 'py-2 text-[11px] text-muted-foreground')}>
          <FormattedMessage
            id="editor.session.teamsOff"
            defaultMessage="Teams are off. Load the Teams extension in Settings → Extensions; conversations started afterwards get the Team tool."
          />
        </div>
      ) : roster && roster.teams.length === 0 ? (
        <div className={cn(INDENT, 'py-2 text-[11px] text-muted-foreground')}>
          <FormattedMessage
            id="editor.session.noTeam"
            defaultMessage="No team yet. Ask the agent to form a team and spawn teammates{types}."
            values={{ types: roster.types.length > 0 ? ` (types: ${roster.types.map((t) => t.id).join(', ')})` : '' }}
          />
        </div>
      ) : null}

      {stats?.exceeded && (
        <div className={cn(INDENT, 'flex items-start gap-2 py-1.5 text-[11px] text-status-warn')}>
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            <FormattedMessage
              id="editor.session.teamPaused"
              defaultMessage="Team paused: {reason}. Raise the budget in Settings → Extensions → Teams to resume."
              values={{ reason: stats.exceeded }}
            />
          </span>
        </div>
      )}

      {roster?.teams.map((team) => (
        <div key={team.label}>
          <div className={cn(INDENT, 'flex items-center gap-2 pb-1 pt-2 text-[11px] text-muted-foreground')}>
            <MessageSquare className="h-3 w-3 shrink-0" />
            <span className="truncate font-medium text-foreground/85">{team.name}</span>
            <span className="min-w-0 flex-1 truncate">
              <FormattedMessage id="editor.session.memberCount" defaultMessage="{count, plural, one {# member} other {# members}}" values={{ count: team.members.length }} />
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-[11px] text-muted-foreground hover:text-destructive"
              title={intl.formatMessage({ id: 'editor.session.disbandHint', defaultMessage: "Disband: free the members' names and close their sessions" })}
              onClick={() => setConfirming(team)}
            >
              <FormattedMessage id="editor.session.disband" defaultMessage="Disband" />
            </Button>
          </div>
          <div className={ROWS}>
            {team.members.map((m) => (
              <div
                key={m.sessionId}
                className={cn(ROW, 'group -mx-1 rounded px-1 hover:bg-secondary-hover')}
                title={m.description || m.typeTitle}
              >
                <div className="flex h-5 items-center gap-2">
                  <RowDot className={MEMBER_DOT[m.status]} />
                  <span className="min-w-0 shrink truncate text-foreground/85">{m.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/50">{m.typeTitle}</span>
                  {m.pendingApprovals > 0 ? (
                    <span className="shrink-0 text-[11px] text-status-warn">
                      <FormattedMessage id="editor.session.needsApproval" defaultMessage="needs approval" />
                    </span>
                  ) : (
                    <span className="shrink-0 text-[11px] text-muted-foreground/50">{m.status}</span>
                  )}
                  {m.chatId != null && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 shrink-0 px-2 text-[11px] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => openMemberChat(m)}
                    >
                      <FormattedMessage id="editor.session.open" defaultMessage="Open" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {team.members.length === 0 && <div className={cn(ROW, 'text-[11px] text-muted-foreground')}><FormattedMessage id="editor.session.noTeammates" defaultMessage="No teammates spawned yet." /></div>}
          </div>
        </div>
      ))}

      <DisbandConfirmDialog
        team={confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const label = confirming?.label
          setConfirming(null)
          if (label) void api.peersDisband(label).then(() => res.reload())
        }}
      />

      {stats && (wakePct != null || stats.totals.totalTokens > 0) && (
        <div className={cn(INDENT, 'space-y-1.5 pb-2.5 pt-2')}>
          {wakePct != null && (
            <BudgetBar label={<FormattedMessage id="editor.session.wakes" defaultMessage="Wakes" />} pct={wakePct} value={`${stats.totals.wakes} / ${stats.budget.maxWakes}`} />
          )}
          <SpendBreakdown stats={stats} pct={tokenPct} />
        </div>
      )}
    </Section>
  )
}

/**
 * The fleet's token spend, and — on click — who spent it.
 *
 * The total alone reads as a bug: it is every model call added up (prompt re-sent in full
 * each step, cache reads included), so it dwarfs any single conversation's context and there
 * is no way to tell from it what a teammate actually cost. The framework also bills any
 * conversation that mounted the Teams hub to this same ledger, in a team or not — the `other`
 * rows. Both facts stop being mysterious the moment the number is split by who spent it.
 */
function SpendBreakdown({ stats, pct }: { stats: PeersStatsDTO; pct: number | null }) {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const agents = stats.agents ?? []
  const total = `${compactNumber(stats.totals.totalTokens)}${stats.budget.maxTotalTokens ? ` / ${compactNumber(stats.budget.maxTotalTokens)}` : ''}`

  return (
    <div className="text-[11px] text-muted-foreground">
      <button
        type="button"
        disabled={agents.length === 0}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left disabled:cursor-default"
        title={intl.formatMessage({ id: 'editor.session.tokensHint', defaultMessage: 'Cumulative tokens across every model call — not the size of any one conversation' })}
      >
        <span className="flex items-center gap-1">
          <FormattedMessage id="editor.session.tokens" defaultMessage="Tokens" />
          {agents.length > 0 && (
            <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
          )}
        </span>
        <span className="tabular-nums">{total}</span>
      </button>
      {pct != null && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full transition-[width]', budgetTone(pct))} style={{ width: `${pct}%` }} />
        </div>
      )}
      {open && (
        <div className="mt-1.5 space-y-1 border-l border-border/40 pl-2">
          <div className="text-[10px] text-muted-foreground/70">
            <FormattedMessage
              id="editor.session.spendHint"
              defaultMessage="Every model call added up, cache reads included — a turn spends its whole context on each step."
            />
          </div>
          {agents.map((a) => (
            <div key={a.agentId} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">
                {a.label}
                {a.kind === 'other' && (
                  <span className="ml-1 text-muted-foreground/60">
                    <FormattedMessage id="editor.session.notInTeam" defaultMessage="(not in this team)" />
                  </span>
                )}
                {a.kind === 'lead' && (
                  <span className="ml-1 text-muted-foreground/60">
                    <FormattedMessage id="editor.session.lead" defaultMessage="(lead)" />
                  </span>
                )}
              </span>
              <span className="shrink-0 tabular-nums">{compactNumber(a.totalTokens)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Fill colour of a budget bar by how much of the budget is gone. */
/** A section's footer: says where the full thing lives, and goes there. */
function SettingsLink({ tab, label }: { tab: string; label: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => openSettingsTab(tab)}
      className={cn(INDENT, 'flex w-full items-center gap-1 py-1.5 text-left text-[11px] text-muted-foreground/55 hover:text-foreground')}
    >
      {label}
      <ChevronRight className="h-3 w-3" />
    </button>
  )
}

function budgetTone(pct: number): string {
  return pct >= 100 ? 'bg-status-error' : pct >= 80 ? 'bg-status-warn' : 'bg-status-ok/70'
}

function BudgetBar({ label, pct, value }: { label: React.ReactNode; pct: number; value: string }) {
  const tone = budgetTone(pct)
  return (
    <div className="text-[11px] text-muted-foreground">
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full transition-[width]', tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

// ── Extensions ───────────────────────────────────────────────────────────────
/**
 * What THIS session was born with. Loading an extension in Settings only reaches
 * sessions opened afterwards — this is where that shows.
 */
function ExtensionsSection({ res }: { res: Resource<{ extensions: OperonSessionExtensionDTO[] }> }) {
  const [expanded, setExpanded] = useState(false)
  const list = res.data?.extensions ?? []

  return (
    <Section
      icon={Blocks}
      title={<FormattedMessage id="editor.session.extensions" defaultMessage="Extensions" />}
      badge={<Badge total={list.length} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <StateRow res={res} empty={list.length === 0} emptyText={<FormattedMessage id="editor.session.extensionsEmpty" defaultMessage="No extensions attached to this session." />} />
      <div className={ROWS}>
        {list.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => openSettingsTab('extensions')}
            title={e.uses.length > 0 ? `uses ${e.uses.join(', ')}` : undefined}
            className={cn(ROW, 'group -mx-1 flex w-full items-center gap-2 rounded px-1 text-left hover:bg-secondary-hover')}
          >
            <span className="min-w-0 flex-1 truncate text-foreground/85">{e.id}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground/50">
              {e.builtin
                ? <FormattedMessage id="editor.session.builtin" defaultMessage="built-in" />
                : <FormattedMessage id="editor.session.fileExt" defaultMessage="file" />}
            </span>
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        ))}
      </div>
      <SettingsLink tab="extensions" label={<FormattedMessage id="editor.session.manageExtensions" defaultMessage="Load or configure in Settings" />} />
    </Section>
  )
}
