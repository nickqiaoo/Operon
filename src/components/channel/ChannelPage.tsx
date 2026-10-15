import { useCallback, useEffect, useState } from 'react'
import { FormattedMessage } from 'react-intl'
import { ArrowLeft, Bot, Hash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channel-store'
import { DrawerShell, useDrawer } from '@/components/assistant/Drawer'
import { ChannelMenu } from './ChannelMenu'
import { AgentMenu, ProjectAgentDialog } from './AgentMenu'
import { ChannelChat } from './ChannelChat'
import { TasksPage } from '@/components/task/TasksPage'
import { AgentManageDialog } from './AgentManageDialog'
import { MemberManageDialog } from './MemberManageDialog'
import type { Agent } from '@/types/channel'

interface ChannelPageProps {
  projectId: number
  projectName: string
  onBack: () => void
  onOpenWorkspace?: (workspaceId: number) => void
  /** Deep-link target (inbox notification): open this task's detail.
   *  Cleared via {@link onInitialTaskConsumed}. */
  initialTaskId?: number | null
  onInitialTaskConsumed?: () => void
}

/**
 * A project's board. The tasks fill the page; channels are a button at the end
 * of its toolbar, and one opens in a drawer over the board rather than in place
 * of it — they are where you drop in to talk, not where you work.
 */
export function ChannelPage({ projectId, projectName, onBack, onOpenWorkspace, initialTaskId, onInitialTaskConsumed }: ChannelPageProps) {
  const channels = useChannelStore((s) => s.channels)
  const activeChannelId = useChannelStore((s) => s.activeChannelId)
  const threadRootId = useChannelStore((s) => s.threadRootId)
  const loadAgents = useChannelStore((s) => s.loadAgents)
  const loadChannels = useChannelStore((s) => s.loadChannels)
  const loadSessions = useChannelStore((s) => s.loadSessions)
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel)
  const [menuOpen, setMenuOpen] = useState<'channels' | 'agents' | null>(null)
  const [detailAgent, setDetailAgent] = useState<Agent | null>(null)
  const [showAgentManage, setShowAgentManage] = useState(false)
  const [showMemberManage, setShowMemberManage] = useState(false)

  // Reset channel state when entering a (possibly different) project
  useEffect(() => {
    setActiveChannel(null)
    void Promise.all([
      loadAgents(),
      loadChannels(projectId),
      loadSessions(projectId),
    ])
    return () => {
      setActiveChannel(null)
    }
  }, [projectId, loadAgents, loadChannels, loadSessions, setActiveChannel])

  const activeChannel = channels.find((c) => c.id === activeChannelId) ?? null
  const closeChannel = useCallback(() => setActiveChannel(null), [setActiveChannel])
  const drawer = useDrawer(activeChannel, closeChannel)
  const projectChannelCount = channels.filter((c) => c.projectId === projectId).length
  const agentCount = useChannelStore((s) => s.agents.length)

  // Each popover choice hands off to something that outlives the popover.
  const pick = (action: () => void) => {
    setMenuOpen(null)
    action()
  }
  const menu = (which: 'channels' | 'agents') => ({
    open: menuOpen === which,
    onOpenChange: (open: boolean) => setMenuOpen(open ? which : null),
  })

  // Agents first: they are what the board's tasks are assigned and dispatched to.
  const agentsButton = (
    <Popover {...menu('agents')}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-muted-foreground hover:text-foreground">
          <Bot className="h-3.5 w-3.5" />
          <FormattedMessage id="channel.section.agents" defaultMessage="Agents" />
          {agentCount > 0 && <span className="text-xs tabular-nums text-muted-foreground/60">{agentCount}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <AgentMenu
          onOpenAgent={(agent) => pick(() => setDetailAgent(agent))}
          onManageAgents={() => pick(() => setShowAgentManage(true))}
        />
      </PopoverContent>
    </Popover>
  )

  const channelsButton = (
    <Popover {...menu('channels')}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className={cn('h-8 gap-1.5 text-muted-foreground hover:text-foreground', activeChannel && 'text-foreground')}
        >
          <Hash className="h-3.5 w-3.5" />
          <FormattedMessage id="channel.section.channels" defaultMessage="Channels" />
          {projectChannelCount > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground/60">{projectChannelCount}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <ChannelMenu
          projectId={projectId}
          onOpenChannel={(id) => pick(() => setActiveChannel(id))}
        />
      </PopoverContent>
    </Popover>
  )

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground">
      {/* Titlebar. pl-20 reserves macOS traffic-light room on desktop only;
          the web build has no window controls. */}
      <div className={cn('h-11 shrink-0 flex items-center gap-2 border-b border-border/40 bg-background drag-region pr-5', __APP_TARGET__ !== 'web' ? 'pl-20' : 'pl-3')}>
        <Button
          variant="ghost"
          size="sm"
          className="no-drag gap-2 text-muted-foreground hover:text-foreground rounded-full px-2.5 h-7"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="font-medium"><FormattedMessage id="common.back" defaultMessage="Back" /></span>
        </Button>
        <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">{projectName}</h1>
      </div>

      <div className="relative flex-1 min-h-0">
        <TasksPage
          projectId={projectId}
          onOpenWorkspace={onOpenWorkspace}
          initialTaskId={initialTaskId}
          onInitialTaskConsumed={onInitialTaskConsumed}
          toolbarEnd={
            <>
              {agentsButton}
              {channelsButton}
            </>
          }
        />

        {drawer.shown && (
          // A thread opens beside the conversation, so the drawer makes room for it.
          <DrawerShell active={drawer.active} className={threadRootId ? 'w-[1100px]' : 'w-[680px]'}>
            <ChannelChat
              key={drawer.shown.id}
              channelId={drawer.shown.id}
              onManageMembers={() => setShowMemberManage(true)}
              onClose={closeChannel}
            />
          </DrawerShell>
        )}
      </div>

      {detailAgent && (
        <ProjectAgentDialog
          agent={detailAgent}
          projectId={projectId}
          onClose={() => setDetailAgent(null)}
          onOpenWorkspace={onOpenWorkspace}
        />
      )}

      {showAgentManage && (
        <AgentManageDialog open onClose={() => setShowAgentManage(false)} />
      )}

      {showMemberManage && activeChannel && (
        <MemberManageDialog
          channel={activeChannel}
          onClose={() => setShowMemberManage(false)}
        />
      )}
    </div>
  )
}
