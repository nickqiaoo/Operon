import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { FormattedMessage, useIntl } from 'react-intl'
import { Plus, Hash, Settings2, Trash2, Square, RotateCcw, MessageSquare, ExternalLink, XIcon, ListTodo, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentAvatar } from './AgentAvatar'
import { BindingRow } from './binding-ui'
import { ScrollArea } from '@/components/ui/scroll-area'
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

interface ChannelSidebarProps {
  projectId: number
  view: 'chat' | 'tasks'
  onShowTasks: () => void
  onShowChat: () => void
  onManageAgents: () => void
  onOpenWorkspace?: (workspaceId: number) => void
}

export function ChannelSidebar({ projectId, view, onShowTasks, onShowChat, onManageAgents, onOpenWorkspace }: ChannelSidebarProps) {
  const intl = useIntl()
  const channels = useChannelStore((s) => s.channels)
  const agents = useChannelStore((s) => s.agents)
  const activeChannelId = useChannelStore((s) => s.activeChannelId)
  const threadRoots = useChannelStore((s) => s.threadRoots)
  const threadRootId = useChannelStore((s) => s.threadRootId)
  const sessions = useChannelStore((s) => s.sessions)
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel)
  const setThreadRootId = useChannelStore((s) => s.setThreadRootId)
  const createChannel = useChannelStore((s) => s.createChannel)
  const deleteChannel = useChannelStore((s) => s.deleteChannel)
  const loadSessions = useChannelStore((s) => s.loadSessions)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [detailAgent, setDetailAgent] = useState<Agent | null>(null)

  const projectChannels = channels.filter((c) => c.projectId === projectId)

  // An agent runs a distinct binding per channel; the store's `sessions` holds
  // all of this project's app bindings. Group by agent so the row shows an honest
  // aggregate (not one arbitrary channel) and the detail can break it down.
  const getAgentBindings = (agentId: number) => sessions.filter((s) => s.agentId === agentId)

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      const channel = await createChannel(projectId, name)
      setActiveChannel(channel.id)
      onShowChat()
      setNewName('')
      setCreating(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create channel')
    }
  }

  const handleDeleteChannel = async (id: number) => {
    await deleteChannel(id)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { void handleCreate() }
    if (e.key === 'Escape') { setCreating(false); setNewName('') }
  }

  const handleAgentStop = async (agentId: number) => {
    await api.agentStop(agentId, projectId)
    await loadSessions(projectId)
  }

  const handleAgentReset = async (agentId: number) => {
    if (!window.confirm(intl.formatMessage({ id: 'channel.agent.resetConfirm', defaultMessage: 'Reset this agent? Session will be cleared.' }))) return
    await api.agentReset(agentId, projectId)
    await loadSessions(projectId)
    setDetailAgent(null)
  }

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* viewportClassName forces the radix viewport's inner wrapper from
          `display:table` (which sizes to content max-content and defeats truncate)
          to block, so long thread/channel names ellipsis-truncate instead of
          widening the sidebar panel. */}
      <ScrollArea className="flex-1 min-h-0 w-full" viewportClassName="[&>div]:!block">
        <div className="p-3 space-y-4">
          {/* Top-level destinations — Tasks sits parallel to Channels */}
          <div className="space-y-0.5">
            <button
              onClick={onShowTasks}
              className={cn(
                'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors text-left',
                view === 'tasks'
                  ? 'bg-foreground/[0.07] text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/55'
              )}
            >
              <ListTodo className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate flex-1 min-w-0"><FormattedMessage id="channel.nav.tasks" defaultMessage="Tasks" /></span>
            </button>
          </div>

          {/* Threads section */}
          {threadRoots.length > 0 && (
            <div>
              <div className="flex items-center px-2 mb-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide"><FormattedMessage id="channel.section.threads" defaultMessage="Threads" /></span>
              </div>
              <div className="space-y-0.5">
                {threadRoots.map((thread) => (
                  <button
                    key={thread.id}
                    onClick={() => setThreadRootId(thread.id)}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors text-left',
                      threadRootId === thread.id
                        ? 'bg-foreground/[0.07] text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/55'
                    )}
                  >
                    <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate flex-1 min-w-0">{thread.content.slice(0, 40)}</span>
                    <span className="text-[10px] text-muted-foreground/50 shrink-0">{thread.replyCount}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Channels section */}
          <div>
            <div className="flex items-center justify-between px-2 mb-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide"><FormattedMessage id="channel.section.channels" defaultMessage="Channels" /></span>
              <button
                onClick={() => setCreating(true)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>

            {creating && (
              <div className="px-2 mb-1">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={() => { if (!newName.trim()) { setCreating(false) } }}
                  placeholder={intl.formatMessage({ id: 'channel.newChannelPlaceholder', defaultMessage: 'channel-name' })}
                  className="w-full text-sm bg-popover/70 border border-border/40 rounded-md px-2 py-1 outline-none focus:border-tint/30 text-foreground placeholder:text-muted-foreground/40 transition-colors"
                />
              </div>
            )}

            <div className="space-y-0.5">
              {projectChannels.length === 0 && !creating && (
                <div className="px-2 py-2 text-xs text-muted-foreground/50">
                  <FormattedMessage id="channel.noChannels" defaultMessage="No channels yet" />
                </div>
              )}
              {projectChannels.map((channel) => (
                <div key={channel.id} className="group relative flex items-center">
                  <button
                    onClick={() => { setActiveChannel(channel.id); onShowChat() }}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors text-left',
                      activeChannelId === channel.id && view === 'chat'
                        ? 'bg-foreground/[0.07] text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/55'
                    )}
                  >
                    <Hash className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate flex-1 min-w-0">{channel.name}</span>
                  </button>
                  <button
                    onClick={() => void handleDeleteChannel(channel.id)}
                    className="absolute right-1 opacity-0 group-hover:opacity-100 p-1 text-muted-foreground/50 hover:text-destructive rounded transition-all"
                    title={intl.formatMessage({ id: 'channel.deleteChannel', defaultMessage: 'Delete channel' })}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Agents section */}
          <div>
            <div className="flex items-center px-2 mb-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide"><FormattedMessage id="channel.section.agents" defaultMessage="Agents" /></span>
            </div>
            <div className="space-y-0.5">
              {agents.length === 0 && (
                <div className="px-2 py-2 text-xs text-muted-foreground/50">
                  <FormattedMessage id="channel.noAgents" defaultMessage="No agents yet" />
                </div>
              )}
              {agents.map((agent) => {
                const bindings = getAgentBindings(agent.id)
                // No aggregate status here: an agent runs a distinct session per
                // channel, so a single dot would be misleading (one active
                // channel would light the agent up everywhere). Status is shown
                // per-binding in the detail dialog. We only surface a neutral
                // count of how many sessions are live.
                const liveCount = bindings.filter((b) => b.status === 'active' || b.status === 'idle').length
                return (
                  <button
                    key={agent.id}
                    onClick={() => setDetailAgent(agent)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-muted-foreground hover:bg-muted/45 hover:text-foreground transition-colors text-left"
                  >
                    <AgentAvatar provider={agent.provider} size="sm" />
                    <span className="flex-1 truncate min-w-0">{agent.name}</span>
                    {liveCount > 1 && (
                      <span
                        className="text-[10px] tabular-nums text-muted-foreground/50 shrink-0"
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
        </div>
      </ScrollArea>

      {/* Manage Agents */}
      <div className="p-3 border-t border-border/40 shrink-0">
        <button
          onClick={onManageAgents}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/55 rounded-lg transition-colors"
        >
          <Settings2 className="w-3.5 h-3.5" />
          <FormattedMessage id="channel.manageAgents" defaultMessage="Manage Agents" />
        </button>
      </div>

      {/* Agent detail dialog */}
      {detailAgent && (
        <AgentDetailDialog
          agent={detailAgent}
          projectId={projectId}
          onClose={() => setDetailAgent(null)}
          onStop={() => void handleAgentStop(detailAgent.id)}
          onReset={() => void handleAgentReset(detailAgent.id)}
          onOpenWorkspace={onOpenWorkspace}
          onBindingsChanged={() => void loadSessions(projectId)}
        />
      )}
    </div>
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
  projectId: number
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
    (b) => b.projectId === projectId && (b.scopeKind === 'app' || b.scopeKind === 'task'),
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
  const workspaceId = projectBindings.find((b) => b.workspaceId != null)?.workspaceId ?? null

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
                <DialogTitle className="text-base font-semibold tracking-tight truncate">
                  {agent.name}
                </DialogTitle>
                <p className="text-xs text-muted-foreground/60 mt-0.5">{agent.provider} · {agent.model}</p>
              </div>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full text-muted-foreground/50 hover:bg-muted/50 shrink-0 -mt-1 -mr-1" onClick={onClose}>
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
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-muted/45 rounded-lg transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5 text-tint" />
              <FormattedMessage id="channel.agent.openWorkspace" defaultMessage="Open Workspace" />
            </button>
          )}
          {hasActive && (
            <button
              onClick={onStop}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-muted/45 rounded-lg transition-colors"
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
