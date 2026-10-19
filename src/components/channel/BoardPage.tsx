import { useCallback, useEffect, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { Bot, PanelLeft, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { PageVisibleContext, usePageVisible } from '@/lib/page-visibility'
import { useChannelStore } from '@/stores/channel-store'
import { ProjectFilterSelect, useProjectFilter } from '@/components/project/ProjectFilterSelect'
import { useTaskStore } from '@/stores/task-store'
import { useTaskStream } from '@/hooks/useTaskStream'
import { AgentMenu, ProjectAgentDialog } from './AgentMenu'
import { ChannelsView } from './ChannelsView'
import { TasksPage } from '@/components/task/TasksPage'
import { AgentManageDialog } from './AgentManageDialog'
import type { Agent } from '@/types/channel'

export type BoardPageView = 'board' | 'channels'

interface BoardPageProps {
  view: BoardPageView
  /** A task opens its channel, a message its task: the other sidebar entry. */
  onViewChange: (view: BoardPageView) => void
  sidebarCollapsed: boolean
  onExpandSidebar: () => void
  onOpenWorkspace?: (workspaceId: number) => void
  /** Deep-link target (inbox notification): open this task's detail.
   *  Cleared via {@link onInitialTaskConsumed}. */
  initialTaskId?: number | null
  onInitialTaskConsumed?: () => void
}

/**
 * Every project's tasks (the Board) or channels (Channels), beside the sidebar
 * that has an entry for each. One component serves both so they share the
 * project filter (all projects by default) and the loaded data, and link into
 * each other: a task captured from a message opens that message, a message
 * shows the tasks made from it.
 */
export function BoardPage({ view, onViewChange, sidebarCollapsed, onExpandSidebar, onOpenWorkspace, initialTaskId, onInitialTaskConsumed }: BoardPageProps) {
  const intl = useIntl()
  const loadAgents = useChannelStore((s) => s.loadAgents)
  const loadChannels = useChannelStore((s) => s.loadChannels)
  const loadSessions = useChannelStore((s) => s.loadSessions)
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel)
  const agentCount = useChannelStore((s) => s.agents.length)
  const loadTasks = useTaskStore((s) => s.load)
  const openDetail = useTaskStore((s) => s.openDetail)
  const [filter, changeFilter] = useProjectFilter('operon.boardProjectFilter')
  const [channelFocus, setChannelFocus] = useState<{ channelId: number; messageId: number | null } | null>(null)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [detailAgent, setDetailAgent] = useState<Agent | null>(null)
  const [showAgentManage, setShowAgentManage] = useState(false)
  const [newChannelOpen, setNewChannelOpen] = useState(false)
  // Board and Channels each mount on first visit and then stay, so flipping between them
  // keeps the open channel, the task detail and their scroll.
  const [mountedViews, setMountedViews] = useState<ReadonlySet<BoardPageView>>(() => new Set([view]))
  if (!mountedViews.has(view)) setMountedViews(new Set([...mountedViews, view]))
  const pageVisible = usePageVisible()

  // Both views read everything, filtered on the client: switching project or view
  // is instant, and the channel view's task chips need the tasks too.
  useEffect(() => {
    void Promise.all([loadAgents(), loadChannels(null), loadSessions(null), loadTasks(null)])
    return () => {
      setActiveChannel(null)
    }
  }, [loadAgents, loadChannels, loadSessions, loadTasks, setActiveChannel])
  useTaskStream(null)

  const openChannel = useCallback(
    (channelId: number, messageId: number | null) => {
      setChannelFocus({ channelId, messageId })
      onViewChange('channels')
    },
    [onViewChange],
  )
  const openTask = useCallback(
    (taskId: number) => {
      void openDetail(taskId)
      onViewChange('board')
    },
    [openDetail, onViewChange],
  )
  const clearChannelFocus = useCallback(() => setChannelFocus(null), [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      {/* Same header as the Inbox beside the same sidebar. pl-20 clears the macOS
          traffic lights once the sidebar is collapsed (desktop only). */}
      <div
        className={cn(
          'drag-region flex h-10 shrink-0 items-center gap-2 border-b border-border/50 bg-background pr-3',
          sidebarCollapsed && __APP_TARGET__ !== 'web' ? 'pl-20' : 'pl-4',
        )}
      >
        {sidebarCollapsed && (
          <button
            type="button"
            onClick={onExpandSidebar}
            title={intl.formatMessage({ id: 'assistant.expandSidebar', defaultMessage: 'Expand sidebar' })}
            className="no-drag flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}
        <span className="text-xs text-muted-foreground">
          {view === 'board'
            ? <FormattedMessage id="sidebar.board" defaultMessage="Board" />
            : <FormattedMessage id="sidebar.channels" defaultMessage="Channels" />}
        </span>

        <div className="flex-1" />

        {view === 'channels' && (
          <Button
            size="sm"
            variant="ghost"
            className="no-drag h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setNewChannelOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            <FormattedMessage id="mobile.channel.newChannel" defaultMessage="New channel" />
          </Button>
        )}

        <ProjectFilterSelect value={filter} onChange={changeFilter} />

        {/* Agents are global: the ones tasks are assigned and dispatched to, and channels summon. */}
        <Popover open={agentsOpen} onOpenChange={setAgentsOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" className="no-drag h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <Bot className="h-3.5 w-3.5" />
              <FormattedMessage id="channel.section.agents" defaultMessage="Agents" />
              {agentCount > 0 && <span className="text-xs tabular-nums text-muted-foreground/60">{agentCount}</span>}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-0">
            <AgentMenu
              onOpenAgent={(agent) => {
                setAgentsOpen(false)
                setDetailAgent(agent)
              }}
              onManageAgents={() => {
                setAgentsOpen(false)
                setShowAgentManage(true)
              }}
            />
          </PopoverContent>
        </Popover>
      </div>

      <div className="relative flex-1 min-h-0">
        {mountedViews.has('board') && (
          <div className={cn('h-full', view !== 'board' && 'hidden')}>
            <PageVisibleContext value={pageVisible && view === 'board'}>
              <TasksPage
                projectFilter={filter}
                onOpenWorkspace={onOpenWorkspace}
                onOpenChannel={openChannel}
                initialTaskId={initialTaskId}
                onInitialTaskConsumed={onInitialTaskConsumed}
              />
            </PageVisibleContext>
          </div>
        )}
        {mountedViews.has('channels') && (
          <div className={cn('h-full', view !== 'channels' && 'hidden')}>
            <PageVisibleContext value={pageVisible && view === 'channels'}>
              <ChannelsView
                projectFilter={filter}
                focus={channelFocus}
                onFocusConsumed={clearChannelFocus}
                onOpenTask={openTask}
                newChannelOpen={newChannelOpen}
                onNewChannelOpenChange={setNewChannelOpen}
              />
            </PageVisibleContext>
          </div>
        )}
      </div>

      {detailAgent && (
        <ProjectAgentDialog
          agent={detailAgent}
          projectId={filter}
          onClose={() => setDetailAgent(null)}
          onOpenWorkspace={onOpenWorkspace}
        />
      )}

      {showAgentManage && (
        <AgentManageDialog open onClose={() => setShowAgentManage(false)} />
      )}
    </div>
  )
}
