import { useEffect, useState } from 'react'
import { FormattedMessage } from 'react-intl'
import { ArrowLeft, MessageSquare } from 'lucide-react'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { Button } from '@/components/ui/button'
import { useChannelStore } from '@/stores/channel-store'
import { ChannelSidebar } from './ChannelSidebar'
import { ChannelChat } from './ChannelChat'
import { TasksPage } from '@/components/task/TasksPage'
import { AgentManageDialog } from './AgentManageDialog'
import { MemberManageDialog } from './MemberManageDialog'
import { api } from '@/lib/api'

interface ChannelPageProps {
  projectId: number
  projectName: string
  onBack: () => void
  onOpenWorkspace?: (workspaceId: number) => void
  /** Deep-link target (inbox notification): jump straight to Tasks and open this
   *  task's detail. Cleared via {@link onInitialTaskConsumed}. */
  initialTaskId?: number | null
  onInitialTaskConsumed?: () => void
}

export function ChannelPage({ projectId, projectName, onBack, onOpenWorkspace, initialTaskId, onInitialTaskConsumed }: ChannelPageProps) {
  const channels = useChannelStore((s) => s.channels)
  const activeChannelId = useChannelStore((s) => s.activeChannelId)
  const loadAgents = useChannelStore((s) => s.loadAgents)
  const loadChannels = useChannelStore((s) => s.loadChannels)
  const loadSessions = useChannelStore((s) => s.loadSessions)
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel)
  const [showAgentManage, setShowAgentManage] = useState(false)
  const [showMemberManage, setShowMemberManage] = useState(false)
  const [providers, setProviders] = useState<{ id: string; label: string }[]>([])
  const [view, setView] = useState<'chat' | 'tasks'>('chat')

  // Reset channel state when entering a (possibly different) project
  useEffect(() => {
    setActiveChannel(null)
    setView('chat')
    void Promise.all([
      loadAgents(),
      loadChannels(projectId),
      loadSessions(projectId),
      api.getProviders().then((list) => setProviders(list.map((p) => ({ id: p.id, label: p.label })))),
    ])
    return () => {
      setActiveChannel(null)
    }
  }, [projectId, loadAgents, loadChannels, loadSessions, setActiveChannel])

  // Deep-link: a task notification lands us on Tasks (not the default chat view).
  // Declared after the reset effect above so it wins when both fire on entry.
  useEffect(() => {
    if (initialTaskId != null) setView('tasks')
  }, [initialTaskId])

  const activeChannel = channels.find((c) => c.id === activeChannelId) ?? null

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground">
      {/* Body — each panel carries its own titlebar strip so the sidebar/main divider extends to the top */}
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize="18%" minSize="14%" maxSize="30%" className="bg-sidebar border-r border-border/50 min-w-0 overflow-hidden">
            <div className="h-full flex flex-col overflow-hidden min-w-0">
              {/* Titlebar strip — sidebar side. pl-20 reserves macOS traffic-light
                  room on desktop only; the web build has no window controls. */}
              <div className={`h-11 ${__APP_TARGET__ !== 'web' ? 'pl-20' : 'pl-5'} pr-3 border-b border-border/40 bg-sidebar drag-region shrink-0 flex items-center`}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="no-drag gap-2 text-muted-foreground hover:text-foreground rounded-full px-2.5 h-7"
                  onClick={onBack}
                >
                  <ArrowLeft className="h-4 w-4" />
                  <span className="font-medium"><FormattedMessage id="common.back" defaultMessage="Back" /></span>
                </Button>
              </div>
              <ChannelSidebar
                projectId={projectId}
                view={view}
                onShowTasks={() => setView('tasks')}
                onShowChat={() => setView('chat')}
                onManageAgents={() => setShowAgentManage(true)}
                onOpenWorkspace={onOpenWorkspace}
              />
            </div>
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel defaultSize="82%" minSize="50%">
            <div className="h-full flex flex-col min-h-0">
              {/* Titlebar strip — main side */}
              <div className="h-11 border-b border-border/40 bg-background drag-region shrink-0 flex items-center px-5">
                <h1 className="text-base font-semibold tracking-tight">{projectName}</h1>
              </div>
              <div className="flex-1 min-h-0">
                {view === 'tasks' ? (
                  <TasksPage
                    projectId={projectId}
                    onOpenWorkspace={onOpenWorkspace}
                    initialTaskId={initialTaskId}
                    onInitialTaskConsumed={onInitialTaskConsumed}
                  />
                ) : activeChannel ? (
                  <ChannelChat
                    key={activeChannel.id}
                    channelId={activeChannel.id}
                    onManageMembers={() => setShowMemberManage(true)}
                  />
                ) : (
                  <EmptyState />
                )}
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* Agent manage dialog */}
      {showAgentManage && (
        <AgentManageDialog
          open
          onClose={() => setShowAgentManage(false)}
          providers={providers}
        />
      )}

      {/* Member manage dialog */}
      {showMemberManage && activeChannel && (
        <MemberManageDialog
          channel={activeChannel}
          onClose={() => setShowMemberManage(false)}
        />
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-4 bg-background">
      <div className="size-16 rounded-2xl border border-border/40 bg-popover/70 flex items-center justify-center">
        <MessageSquare className="h-7 w-7 opacity-35" />
      </div>
      <div className="text-center space-y-1">
        <p className="text-sm font-medium text-foreground/85">
          <FormattedMessage id="channel.empty.title" defaultMessage="No channel selected" />
        </p>
        <p className="text-sm text-muted-foreground/60">
          <FormattedMessage id="channel.empty.hint" defaultMessage="Create a channel or select one from the sidebar" />
        </p>
      </div>
    </div>
  )
}
