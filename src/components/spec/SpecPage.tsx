import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowUpRight, GitBranch, Loader2, MessageSquareText, PanelLeft } from 'lucide-react'
import { SpecIcon } from '@/components/icons/SpecIcon'
import type { SpecChatRef } from '@shared/spec'
import { Button } from '@/components/ui/button'
import { ProviderIcon } from '@/components/icons/ProviderLabel'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SessionPanelToggle, TopBarControls } from '@/components/app-shell/TopBarControls'
import { AccountUsageBar } from '@/components/app-shell/AccountUsageBar'
import { useAppShellStore } from '@/stores/app-shell-store'
import { useEditorStore } from '@/stores/editor-store'
import { ReviewTab } from '@/components/app-shell/content/ReviewTab'
import type { Workspace } from '@/stores/project-store'
import { useProjectStore } from '@/stores/project-store'
import { PageVisibleContext, usePageVisible } from '@/lib/page-visibility'
import { ChatReadOnlyContext } from '@/lib/chat-read-only'
import { fileCitationsToText } from '@/lib/file-citation'
import { cn } from '@/lib/utils'
import { listSpecSessions } from './session-groups'
import { SpecOverview } from './SpecPanel'
import { SpecStageBadge, useSpecView } from './spec-shared'
import { specSessionWorkspace } from './session-context'

type Section = 'overview' | 'discussion' | 'sessions' | 'changes'

interface SpecPageProps {
  target: { taskId: number; projectId: number } | null
  sidebarCollapsed: boolean
  onExpandSidebar: () => void
  onOpenWorkspace: (workspaceId: number) => void
  onFocusWorkspace: (workspaceId: number | null, projectId: number) => void
  onFocusChat: (chat: SpecChatRef, projectId: number) => void
  workspaceHeader: ReactNode
  children: ReactNode
}

/** One workbench and one chat surface, reached from a directory or a Spec. */
export function SpecPage({ target, sidebarCollapsed, onExpandSidebar, onOpenWorkspace, onFocusWorkspace, onFocusChat, workspaceHeader, children }: SpecPageProps) {
  const visible = usePageVisible()
  const taskId = target?.taskId ?? 0
  const { spec, error } = useSpecView(taskId, undefined, visible && target != null)
  const project = useProjectStore((state) => state.projects.find((item) => item.id === target?.projectId))
  const rightPanelOpen = useAppShellStore((state) => state.rightPanelOpen)
  const [navigation, setNavigation] = useState<Record<number, { section: Section; sessionId: number | null }>>({})
  const { section, sessionId } = navigation[taskId] ?? { section: 'overview', sessionId: null }
  const chooseSection = (next: Section) => {
    setNavigation((previous) => ({ ...previous, [taskId]: { section: next, sessionId } }))
  }
  const openSession = (chat: SpecChatRef) => {
    setNavigation((previous) => ({ ...previous, [taskId]: { sessionId: chat.chatId, section: chat.chatId === spec?.sourceChat?.chatId ? 'discussion' : 'sessions' } }))
  }
  const workspaces = project?.workspaces.filter((workspace) =>
    workspace.task?.id === taskId || workspace.task?.parentTaskId === taskId,
  ) ?? []
  const workspace = workspaces.find((item) => item.task?.id === taskId)
  const sessions = spec ? listSpecSessions(spec).filter((entry) => entry.chat.chatId !== spec.sourceChat?.chatId) : []
  const selectedSession = sessions.find((entry) => entry.chat.chatId === sessionId) ?? sessions[0]

  const conversation = section === 'discussion' ? spec?.sourceChat : section === 'sessions' ? selectedSession?.chat : null
  const activeChatId = useEditorStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId)?.chatId)
  const showConversation = target == null || (conversation != null && conversation.chatId === activeChatId)
  // Where the open conversation ran. Once that worktree is gone the
  // conversation is history: it opens in no workspace and can't be continued.
  const conversationWorkspace = project && conversation ? specSessionWorkspace(project, conversation) : null
  const conversationRemoved = project != null && conversation != null && conversationWorkspace == null
  const readOnly = useMemo(() => conversationRemoved && conversation
    ? {
        chatId: conversation.chatId,
        reason: section === 'discussion'
          ? 'The workspace this discussion ran in has been removed.'
          : "This session's worktree has been removed. Follow up in Discussion.",
      }
    : null, [conversationRemoved, conversation?.chatId, section])
  useEffect(() => {
    if (!visible || !project || !spec || target == null) return
    if (conversation) onFocusChat({ ...conversation, workspaceId: specSessionWorkspace(project, conversation)?.id ?? null }, project.id)
    else onFocusWorkspace(specSessionWorkspace(project, spec.sourceChat)?.id ?? null, project.id)
  }, [visible, target?.taskId, project?.id, spec?.taskId, conversation?.chatId, conversation?.workspaceId, workspace?.id, onFocusChat, onFocusWorkspace])

  return (
    <div className="@container/spec flex h-full min-h-0 flex-col bg-background" data-testid={target ? 'spec-page' : undefined} data-spec-id={target?.taskId}>
      {target ? <>
      <div className={cn('@container/topbar drag-region flex h-10 shrink-0 items-center gap-2 border-b border-border/40 pr-3 text-xs text-muted-foreground', sidebarCollapsed && __APP_TARGET__ !== 'web' ? 'pl-20' : 'pl-4')}>
        {sidebarCollapsed && (
          <Button variant="ghost" size="icon-sm" className="no-drag" onClick={onExpandSidebar} aria-label="Expand sidebar"><PanelLeft className="size-4" /></Button>
        )}
        <span className="shrink-0">{project?.name ?? 'Project'}</span>
        <span className="text-muted-foreground/40">/</span>
        <SpecIcon className="size-3.5 shrink-0" />
        <span className="shrink-0">Spec {spec ? `#${spec.taskNumber}` : ''}</span>
        {spec && <span className="min-w-0 truncate text-foreground/80">{fileCitationsToText(spec.title)}</span>}
        <div className="flex-1" />
        <AccountUsageBar className="shrink-0 pr-0.5" />
        <SessionPanelToggle className={rightPanelOpen ? "mr-2" : "mr-0.5"} />
        {!rightPanelOpen && <TopBarControls />}
      </div>

      {spec && <Tabs value={section} onValueChange={(value) => chooseSection(value as Section)} className="shrink-0 gap-0">
          <div className="flex shrink-0 items-center gap-3 border-b border-border/40 px-4">
            <TabsList aria-label="Spec navigation" className="h-11 min-w-0 flex-1 justify-start gap-5 overflow-x-auto rounded-none bg-transparent p-0 scrollbar-none">
              {(['overview', 'discussion', 'sessions', 'changes'] as const).map((item) => (
                <TabsTrigger key={item} value={item} id={`spec-tab-${taskId}-${item}`} aria-controls={`spec-content-${taskId}`} className="relative h-full flex-none rounded-none border-0 bg-transparent px-0 text-xs capitalize text-muted-foreground shadow-none after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:after:bg-tint">
                  {item}{item === 'sessions' && sessions.length > 0 && <span className="ml-1 text-[10px] tabular-nums text-muted-foreground">{sessions.length}</span>}
                </TabsTrigger>
              ))}
            </TabsList>
            <span className="@max-[680px]/spec:hidden"><SpecStageBadge stage={spec.run.stage} running={spec.running} /></span>
            {workspace && section !== 'changes' && <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 text-xs @max-[680px]/spec:hidden" onClick={() => onOpenWorkspace(workspace.id)}>Open workspace <ArrowUpRight className="size-3.5" /></Button>}
          </div>

      </Tabs>}
      </> : workspaceHeader}

      <div id={target ? `spec-content-${taskId}` : undefined} role={target ? 'tabpanel' : undefined} aria-labelledby={target ? `spec-tab-${taskId}-${section}` : undefined} className="flex min-h-0 flex-1">
        {target && section === 'sessions' && spec && (
          <nav aria-label="Spec sessions" className="flex w-52 shrink-0 flex-col gap-1 overflow-auto border-r border-border/40 px-2 py-3 @max-[680px]/spec:hidden">
            {sessions.map((entry, index) => (
              <div key={entry.chat.chatId} className={cn(index > 0 && entry.phase && entry.phase !== sessions[index - 1]?.phase && 'mt-5')}>
                {entry.phase && entry.phase !== sessions[index - 1]?.phase && <h3 className="px-2 pb-2 text-sm font-semibold uppercase tracking-wide text-foreground/90">{entry.phase}</h3>}
                <button type="button" aria-current={entry.chat.chatId === selectedSession?.chat.chatId ? 'page' : undefined} onClick={() => openSession(entry.chat)} title={fileCitationsToText(entry.label)} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs leading-5 text-muted-foreground transition-colors hover:bg-row-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50', entry.phase && 'pl-5', entry.chat.chatId === selectedSession?.chat.chatId && 'bg-row-selected font-medium text-foreground')}>
                  {entry.chat.providerId ? <ProviderIcon id={entry.chat.providerId} size={14} /> : <MessageSquareText className="size-3.5 shrink-0" />}
                  <span className="line-clamp-2 min-w-0 flex-1">{fileCitationsToText(entry.label)}</span>
                  {entry.state === 'running' && <Loader2 className="size-3 shrink-0 animate-spin" />}
                </button>
              </div>
            ))}
          </nav>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {target && conversation && <div className="flex shrink-0 items-center gap-2 border-b border-border/30 px-4 py-2 text-xs text-muted-foreground">
            {section === 'sessions' && <select aria-label="Spec session" value={selectedSession?.chat.chatId} onChange={(event) => {
              const entry = sessions.find((item) => item.chat.chatId === Number(event.target.value))
              if (entry) openSession(entry.chat)
            }} className="min-w-0 flex-1 bg-transparent text-xs outline-none @min-[681px]/spec:hidden">
              {sessions.map((entry) => <option key={entry.chat.chatId} value={entry.chat.chatId}>{fileCitationsToText(entry.label)}</option>)}
            </select>}
            <span className={cn('min-w-0 truncate', section === 'sessions' && '@max-[680px]/spec:hidden')}>{fileCitationsToText(conversation.title)}</span>
            {conversationWorkspace
              ? <span className="ml-auto flex shrink-0 items-center gap-1" title={conversationWorkspace.worktreePath}><GitBranch className="size-3" />{conversationWorkspace.branchName}</span>
              : conversationRemoved && <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground/60" title={conversation.cwd ? `Worktree removed: ${conversation.cwd}` : 'Worktree removed'}><GitBranch className="size-3" />{section === 'sessions' && spec?.branchName ? `${spec.branchName} · removed` : 'Worktree removed'}</span>}
          </div>}
          {target && !spec && <EmptyState>{error ?? 'Loading Spec…'}</EmptyState>}
          {target && spec && section === 'overview' && (
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="mx-auto max-w-4xl px-5 py-7 md:px-8">
                <h1 className="mb-5 text-xl font-semibold tracking-tight">{fileCitationsToText(spec.title)}</h1>
                <SpecOverview key={taskId} spec={spec} onOpenChat={openSession} onOpenWorkspace={onOpenWorkspace} />
              </div>
            </div>
          )}
          {target && spec && section === 'changes' && <div className="min-h-0 flex-1"><SpecChanges key={taskId} taskId={taskId} workspaces={workspaces} onOpenWorkspace={onOpenWorkspace} /></div>}
          {target && spec && section === 'discussion' && !conversation && <EmptyState>No discussion is linked to this Spec.</EmptyState>}
          {target && spec && section === 'sessions' && !conversation && <EmptyState>No agent sessions yet.</EmptyState>}
          <PageVisibleContext value={visible && showConversation}>
            <ChatReadOnlyContext value={readOnly}>
              <div className={cn('relative flex min-h-0 flex-1 flex-col', !showConversation && 'hidden')}>{children}</div>
            </ChatReadOnlyContext>
          </PageVisibleContext>
        </div>
      </div>
    </div>
  )
}

function SpecChanges({ taskId, workspaces, onOpenWorkspace }: {
  taskId: number
  workspaces: Workspace[]
  onOpenWorkspace: (workspaceId: number) => void
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const workspace = workspaces.find((item) => item.id === selectedId) ?? workspaces.find((item) => item.task?.id === taskId) ?? workspaces[0]
  if (!workspace) return <EmptyState>The workspaces for this Spec have been removed. Sessions and review documents remain available.</EmptyState>
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-4 py-2">
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        <select aria-label="Spec workspace" value={workspace.id} onChange={(event) => setSelectedId(Number(event.target.value))} className="min-w-0 flex-1 bg-transparent text-xs outline-none">
          {workspaces.map((item) => <option key={item.id} value={item.id}>{item.task?.id === taskId ? 'Spec' : `Ticket #${item.task?.number}`} · {item.branchName}</option>)}
        </select>
        <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => onOpenWorkspace(workspace.id)}>Open workspace <ArrowUpRight className="size-3.5" /></Button>
      </div>
      <div className="min-h-0 flex-1">
        <ReviewTab key={workspace.id} tabId={`spec-changes:${taskId}:${workspace.id}`} rootPath={workspace.worktreePath} workspaceId={workspace.id} initialScope="branch" />
      </div>
    </div>
  )
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">{children}</div>
}
