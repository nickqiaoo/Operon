import { useState, useEffect } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { Settings2, Square, RotateCcw, ExternalLink, XIcon, Loader2 } from 'lucide-react'
import { AgentAvatar } from '@/components/icons/AgentAvatar'
import { BindingRow } from './binding-ui'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useChannelStore } from '@/stores/channel-store'
import { api } from '@/lib/api'
import type { Agent, AgentBinding } from '@/types/channel'

const ROW =
  'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors text-left text-muted-foreground hover:bg-accent hover:text-accent-foreground'

interface AgentMenuProps {
  onOpenAgent: (agent: Agent) => void
  onManageAgents: () => void
}

/**
 * The agents tasks are assigned and dispatched to, behind their own button on the board's
 * toolbar: one opens its sessions here (stop / reset), "Manage Agents" creates and edits them.
 */
export function AgentMenu({ onOpenAgent, onManageAgents }: AgentMenuProps) {
  const intl = useIntl()
  const agents = useChannelStore((s) => s.agents)
  const sessions = useChannelStore((s) => s.sessions)

  return (
    <div className="flex max-h-[min(70vh,520px)] flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        <div className="px-2 pb-1 pt-1">
          <span className="text-xs font-semibold text-muted-foreground"><FormattedMessage id="channel.section.agents" defaultMessage="Agents" /></span>
        </div>
        <div className="space-y-0.5">
          {agents.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground/60">
              <FormattedMessage id="channel.noAgents" defaultMessage="No agents yet" />
            </div>
          )}
          {agents.map((agent) => {
            // No aggregate status: an agent runs a distinct session per channel or task, so a
            // single dot would light it up everywhere. The detail dialog shows each session's own.
            const liveCount = sessions.filter(
              (b) => b.agentId === agent.id && (b.status === 'active' || b.status === 'idle'),
            ).length
            return (
              <button key={agent.id} type="button" onClick={() => onOpenAgent(agent)} className={ROW}>
                <AgentAvatar provider={agent.provider} size="sm" />
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                {liveCount > 1 && (
                  <span
                    className="shrink-0 text-[10px] tabular-nums text-muted-foreground/50"
                    title={intl.formatMessage(
                      { id: 'channel.agent.liveChannels', defaultMessage: 'Active in {count} channels' },
                      { count: liveCount },
                    )}
                  >
                    {liveCount}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div className="shrink-0 border-t border-border/40 p-1.5">
        <button type="button" onClick={onManageAgents} className={ROW}>
          <Settings2 className="h-3.5 w-3.5" />
          <FormattedMessage id="channel.manageAgents" defaultMessage="Manage Agents" />
        </button>
      </div>
    </div>
  )
}

/** One agent's sessions in this project (every project for null), with stop / reset. */
export function ProjectAgentDialog({
  agent,
  projectId,
  onClose,
  onOpenWorkspace,
}: {
  agent: Agent
  projectId: number | null
  onClose: () => void
  onOpenWorkspace?: (workspaceId: number) => void
}) {
  const intl = useIntl()
  // The store holds every project's sessions (the board shows them all), so refresh all of them.
  const loadSessions = useChannelStore((s) => s.loadSessions)

  const handleStop = async () => {
    await api.agentStop(agent.id, projectId)
    await loadSessions(null)
  }

  const handleReset = async () => {
    if (!window.confirm(intl.formatMessage({ id: 'channel.agent.resetConfirm', defaultMessage: 'Reset this agent? Session will be cleared.' }))) return
    await api.agentReset(agent.id, projectId)
    await loadSessions(null)
    onClose()
  }

  return (
    <AgentDetailDialog
      agent={agent}
      projectId={projectId}
      onClose={onClose}
      onStop={() => void handleStop()}
      onReset={() => void handleReset()}
      onOpenWorkspace={onOpenWorkspace}
      onBindingsChanged={() => void loadSessions(null)}
    />
  )
}

/* ── Agent detail dialog ── */

function AgentDetailDialog({
  agent,
  projectId,
  onClose,
  onStop,
  onReset,
  onOpenWorkspace,
  onBindingsChanged,
}: {
  agent: Agent
  projectId: number | null
  onClose: () => void
  onStop: () => void
  onReset: () => void
  onOpenWorkspace?: (workspaceId: number) => void
  onBindingsChanged: () => void
}) {
  const [bindings, setBindings] = useState<AgentBinding[]>([])
  const [loading, setLoading] = useState(true)
  const [resettingBinding, setResettingBinding] = useState<number | null>(null)

  const refresh = async () => {
    try {
      const { sessions } = await api.agentListSessions(agent.id)
      setBindings(sessions)
    } catch {
      setBindings([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id])

  // `/agents/:id/sessions` returns the agent's bindings across every surface and
  // project (channels, Slack/Telegram, tasks). In the channel sidebar only this
  // project's channel + task sessions are relevant — IM bindings are managed in
  // Settings. Scope to keep the card focused (and from dumping the agent's whole
  // history into the sidebar).
  const projectBindings = bindings.filter(
    (b) => (projectId == null || b.projectId === projectId) && (b.scopeKind === 'app' || b.scopeKind === 'task'),
  )
  // Offline bindings are reset/never-started residue with no lifecycle that ever
  // clears them — hide them so the Sessions list shows only live (active/idle) rows.
  const visible = projectBindings.filter((b) => b.status !== 'offline')
  // No headline aggregate status: each session below shows its own. This is only
  // a functional check for whether the "Stop" action applies (is anything running).
  const hasActive = visible.some((b) => b.status === 'active')
  // Workspace persists even after a binding goes offline (reset), so derive the
  // workspace link from the full project set — not just the live rows — to keep
  // "Open Workspace" available.
  // Across projects the agent has a workspace in each, and one button can't say which.
  const workspaceIds = new Set(projectBindings.flatMap((b) => (b.workspaceId != null ? [b.workspaceId] : [])))
  const workspaceId = workspaceIds.size === 1 ? [...workspaceIds][0] : null

  const handleBindingReset = async (b: AgentBinding) => {
    setResettingBinding(b.id)
    try {
      await api.bindingReset(b.id)
      await refresh()
      onBindingsChanged()
    } finally {
      setResettingBinding(null)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        className="max-h-[85vh] max-w-xs overflow-hidden p-0 flex flex-col"
        showCloseButton={false}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-4 shrink-0">
          <DialogHeader className="flex flex-row items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <AgentAvatar provider={agent.provider} size="lg" ring />
              <div className="min-w-0">
                <DialogTitle className="truncate">
                  {agent.name}
                </DialogTitle>
                <p className="text-xs text-muted-foreground/60 mt-0.5">{agent.provider} · {agent.model}</p>
              </div>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground shrink-0 -mt-1 -mr-1" onClick={onClose}>
              <XIcon className="h-3.5 w-3.5" />
            </Button>
          </DialogHeader>

          {agent.instructions && (
            <p className="text-xs text-muted-foreground/70 mt-3 leading-relaxed whitespace-pre-wrap">{agent.instructions}</p>
          )}
        </div>

        {/* Sessions — one row per channel/task this agent actually runs in, each
            with its own status and its own reset (the channel layer, made visible).
            Scrolls when long so the card never grows past the viewport. */}
        <div className="border-t border-border/40 px-3 py-3 flex-1 min-h-0 overflow-y-auto">
          <div className="px-1 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/40">
            <FormattedMessage id="channel.agent.sessions" defaultMessage="Sessions" />
          </div>
          {loading ? (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <FormattedMessage id="channel.agent.sessionsLoading" defaultMessage="Loading…" />
            </div>
          ) : visible.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground/50">
              <FormattedMessage id="channel.agent.noSessions" defaultMessage="Not running in any channel yet." />
            </div>
          ) : (
            <div className="space-y-0.5">
              {visible.map((b) => (
                <BindingRow
                  key={b.id}
                  binding={b}
                  resetting={resettingBinding === b.id}
                  onReset={() => void handleBindingReset(b)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="border-t border-border/40 px-2 py-2 space-y-0.5 shrink-0">
          {workspaceId != null && onOpenWorkspace && (
            <button
              onClick={() => { onOpenWorkspace(workspaceId); onClose() }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-row-hover rounded-lg transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5 text-tint" />
              <FormattedMessage id="channel.agent.openWorkspace" defaultMessage="Open Workspace" />
            </button>
          )}
          {hasActive && (
            <button
              onClick={onStop}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-row-hover rounded-lg transition-colors"
            >
              <Square className="w-3.5 h-3.5" />
              <FormattedMessage id="channel.agent.stop" defaultMessage="Stop" />
            </button>
          )}
          <button
            onClick={onReset}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-destructive/80 hover:bg-destructive/5 rounded-lg transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <FormattedMessage id="channel.agent.resetAll" defaultMessage="Reset all sessions" />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
