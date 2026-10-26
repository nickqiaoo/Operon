import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { SpecChatRef } from '@shared/spec'
import { ChatPanel } from '@/components/editor/ChatPanel'
import { SpecOverview } from '@/components/spec/SpecPanel'
import { listSpecSessions } from '@/components/spec/session-groups'
import { specSessionWorkspace } from '@/components/spec/session-context'
import { useSpecView } from '@/components/spec/spec-shared'
import { useBackHandler } from '@/hooks/useAndroidBackButton'
import { useEditorStore } from '@/stores/editor-store'
import { useProjectStore, type Workspace } from '@/stores/project-store'
import { PageVisibleContext } from '@/lib/page-visibility'
import { ChatReadOnlyContext } from '@/lib/chat-read-only'
import { fileCitationsToText } from '@/lib/file-citation'
import { resolveDefaultBase } from '@/lib/git-queries'
import { loadReview } from '@/components/app-shell/content/review/load-review'
import type { FileChange } from '@/components/app-shell/content/review/types'
import { cn } from '@/lib/utils'
import { MobileHeader, MobileHeaderContext, useMobileContentBottom, useMobileContentOffset } from './MobileHeader'
import { MobileSpecChatsList, type MobileSpecChatTarget } from './MobileSpecChatsList'
import { MobileSheet } from './MobileSheet'
import { MobileDiffBrowser } from './MobileDiffBrowser'

type Section = 'Overview' | 'Discussion' | 'Sessions' | 'Changes'
type OpenChat = { tabId: string; chatId: number; providerId?: string }

/** Spec navigation around the existing chat, workflow and mobile diff surfaces. */
export function MobileSpecScreen({ taskId, projectId, keyboardOpen, onExit, onOpenWorkspace, onImmersiveChange }: {
  taskId: number
  projectId: number
  keyboardOpen: boolean
  onExit: () => void
  onOpenWorkspace: (workspaceId: number) => void
  onImmersiveChange: (immersive: boolean) => void
}) {
  const { spec, error } = useSpecView(taskId)
  const project = useProjectStore((state) => state.projects.find((item) => item.id === projectId))
  const shell = useContext(MobileHeaderContext)
  const contentOffset = useMobileContentOffset()
  const contentBottom = useMobileContentBottom()
  const [section, setSection] = useState<Section>('Overview')
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [visited, setVisited] = useState<OpenChat[]>([])
  const [current, setCurrent] = useState<OpenChat | null>(null)
  const sessions = spec ? listSpecSessions(spec).filter((row) => row.chat.chatId !== spec.sourceChat?.chatId) : []
  const conversation = section === 'Discussion' ? spec?.sourceChat : section === 'Sessions' ? sessions.find((row) => row.chat.chatId === sessionId)?.chat : null
  const chatting = conversation != null
  // Its worktree gone, the conversation is history and can't be continued.
  const removed = project != null && conversation != null && specSessionWorkspace(project, conversation) == null
  const readOnly = useMemo(() => removed && conversation
    ? {
        chatId: conversation.chatId,
        reason: section === 'Discussion'
          ? 'The workspace this discussion ran in has been removed.'
          : "This session's worktree has been removed. Follow up in Discussion.",
      }
    : null, [removed, conversation?.chatId, section])
  const focusedId = useRef<number | null>(null)

  const openChat = (chat: SpecChatRef | MobileSpecChatTarget) => {
    setPickerOpen(false)
    setSessionId(chat.chatId)
    setSection(chat.chatId === spec?.sourceChat?.chatId ? 'Discussion' : 'Sessions')
  }
  useEffect(() => {
    onImmersiveChange(chatting)
    return () => onImmersiveChange(false)
  }, [chatting, onImmersiveChange])

  useEffect(() => {
    if (!conversation || !project || focusedId.current === conversation.chatId) return
    focusedId.current = conversation.chatId
    const workspace = specSessionWorkspace(project, conversation)
    useProjectStore.getState().setActiveWorkspace(workspace?.id ?? null, project.id)
    const editor = useEditorStore.getState()
    editor.setWorkspace(workspace?.id ?? null, project.id)
    const tabId = editor.openChatTab(`chat:${conversation.chatId}`, conversation.title, undefined, conversation.providerId ?? undefined, conversation.subAgent)
    editor.setTabChatId(tabId, conversation.chatId)
    editor.setActiveTab(tabId)
    const next = { tabId, chatId: conversation.chatId, providerId: conversation.providerId ?? undefined }
    setCurrent(next)
    setVisited((previous) => previous.some((item) => item.tabId === tabId) ? previous : [...previous, next])
  }, [conversation, project])

  const back = () => {
    if (pickerOpen) setPickerOpen(false)
    else if (section === 'Sessions' && sessionId != null) setSessionId(null)
    else if (section === 'Discussion') setSection('Overview')
    else onExit()
  }
  useBackHandler(true, back)

  const title = section === 'Discussion' ? 'Discussion' : sessions.find((row) => row.chat.chatId === sessionId)?.label
  const workspaces = project?.workspaces.filter((workspace) => workspace.task?.id === taskId || workspace.task?.parentTaskId === taskId) ?? []

  return <div className="relative flex h-full min-h-0 flex-col" data-testid="mobile-spec-page">
    <div className={cn(chatting && 'absolute inset-x-0 top-0 z-30')}>
      <MobileHeader navigation={{
        title: chatting ? fileCitationsToText(title ?? conversation.title) : `Spec #${spec?.taskNumber ?? taskId}`,
        subtitle: chatting ? `Spec #${spec?.taskNumber ?? taskId}` : fileCitationsToText(spec?.title ?? 'Loading…'),
        onBack: back,
        onTitlePress: () => chatting ? setPickerOpen(true) : shell?.openContext(),
      }} />
    </div>
    <div className={cn('flex min-h-0 flex-1 flex-col', chatting && 'hidden')} style={{ paddingTop: contentOffset }}>
      <nav aria-label="Spec navigation" className="flex shrink-0 gap-4 overflow-x-auto border-b border-border/40 px-4">
        {(['Overview', 'Discussion', 'Sessions', 'Changes'] as const).map((item) => <button key={item} type="button" aria-current={section === item ? 'page' : undefined} onClick={() => { setSessionId(null); setSection(item) }} className="h-11 shrink-0 border-b-2 border-transparent text-[13px] font-medium text-muted-foreground aria-[current=page]:border-tint aria-[current=page]:text-foreground">{item}</button>)}
      </nav>
      {!spec && <div role="status" className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">{!error && <Loader2 className="size-4 animate-spin" />}{error ?? 'Loading Spec…'}</div>}
      {spec && <>
        {section === 'Overview' && <div className="min-h-0 flex-1 overflow-auto px-4 py-4" style={{ paddingBottom: `calc(${contentBottom} + 1rem)` }}>
          <h1 className="text-lg font-semibold">{fileCitationsToText(spec.title)}</h1>
          <SpecOverview spec={spec} onOpenChat={openChat} onOpenWorkspace={onOpenWorkspace} />
        </div>}
        {section === 'Discussion' && !conversation && <p className="p-6 text-sm text-muted-foreground">No discussion is linked to this Spec.</p>}
        <div className={cn('min-h-0 flex-1 overflow-auto p-2', section !== 'Sessions' && 'hidden')} style={{ paddingBottom: `calc(${contentBottom} + 0.5rem)` }}>
          <MobileSpecChatsList specId={taskId} view={spec} includeDiscussion={false} selectedChatId={sessionId ?? undefined} onOpenChat={openChat} />
        </div>
        {section === 'Changes' && <MobileSpecChanges workspaces={workspaces} contentBottom={contentBottom} />}
      </>}
    </div>
    {chatting && current?.chatId !== conversation.chatId && <div role="status" className="grid flex-1 place-items-center text-sm text-muted-foreground">Loading conversation…</div>}
    <ChatReadOnlyContext value={readOnly}>
      {visited.map((chat) => {
        const visible = chatting && current?.tabId === chat.tabId && current.chatId === conversation.chatId
        return <PageVisibleContext key={chat.tabId} value={visible}><div className={cn('min-h-0 flex-1', !visible && 'hidden')}>
          <ChatPanel chatId={chat.tabId} providerId={chat.providerId} mobileKeyboardOpen={keyboardOpen} />
        </div></PageVisibleContext>
      })}
    </ChatReadOnlyContext>
    <MobileSheet open={pickerOpen} onClose={() => setPickerOpen(false)} title="Switch conversation">
      {spec && <MobileSpecChatsList specId={taskId} view={spec} selectedChatId={conversation?.chatId} onOpenChat={openChat} />}
    </MobileSheet>
  </div>
}

function MobileSpecChanges({ workspaces, contentBottom }: { workspaces: Workspace[]; contentBottom: string }) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const workspace = workspaces.find((item) => item.id === selectedId) ?? workspaces[0]
  const [result, setResult] = useState<{ path: string; files: FileChange[]; error?: string } | null>(null)
  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    const path = workspace.worktreePath
    void resolveDefaultBase(path).then((baseBranch) => loadReview(path, 'branch', { baseBranch })).then(
      ({ files }) => { if (!cancelled) setResult({ path, files }) },
      () => { if (!cancelled) setResult({ path, files: [], error: 'Could not load changes.' }) },
    )
    return () => { cancelled = true }
  }, [workspace?.worktreePath])
  if (!workspace) return <p className="p-6 text-sm text-muted-foreground">The workspaces for this Spec have been removed. Conversations and review documents remain available.</p>
  const loaded = result?.path === workspace.worktreePath ? result : null
  return <div className="flex min-h-0 flex-1 flex-col">
    <select aria-label="Spec workspace" className="m-3 min-h-11 min-w-0 rounded-lg bg-muted/30 px-3 text-sm" value={workspace.id} onChange={(event) => setSelectedId(Number(event.target.value))}>
      {workspaces.map((item) => <option key={item.id} value={item.id}>{item.branchName}</option>)}
    </select>
    <MobileDiffBrowser key={workspace.id} title="Changes" files={loaded?.files ?? []} loadDiff={(file) => Promise.resolve(file.diff)} loading={!loaded} error={loaded?.error} emptyTitle="No changes" emptyDescription="No changes against the base branch." contentBottom={contentBottom} />
  </div>
}
