import { useMemo, useState } from 'react'
import { ChevronRight, Users } from 'lucide-react'
import { FormattedMessage, useIntl } from 'react-intl'
import { codingAgentName } from '@/components/assistant/CodingAgentCard'
import { ChildPendingInput } from '@/components/editor/components/ChildPendingInput'
import { openChildChat, useOtherWorkspaceName } from '@/hooks/useChatChildren'
import { childCounts, isActiveState, type ChatChild, type ChildState } from '@/lib/chat-children'
import { cn } from '@/lib/utils'
import { Badge, INDENT, ROW, ROWS, RowDot, Section } from './session-panel-parts'

/** Finished rows shown before "Show more". */
const FINISHED_PREVIEW = 5

const CHILD_DOT: Record<ChildState, string> = {
  'needs-you': 'bg-status-warn',
  failed: 'bg-status-error',
  running: 'bg-status-info animate-pulse',
  done: 'bg-status-ok/70',
  stopped: 'bg-muted-foreground/30',
}

/**
 * The Session panel's first card: the external agents this conversation started,
 * the ones that need you on top. Each opens its own conversation.
 */
export function ChildrenSection({ chatId, agents }: { chatId: number; agents: ChatChild[] }) {
  const [expanded, setExpanded] = useState(true)
  const counts = childCounts(agents)
  return (
    <Section
      icon={Users}
      title={<FormattedMessage id="editor.session.agents" defaultMessage="Agents" />}
      badge={<Badge total={counts.total} active={counts.running} problems={counts.needsYou + counts.failed} />}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <ChatChildrenList key={chatId} agents={agents} />
    </Section>
  )
}

/** In play first (needs you, failed, running), the finished ones folded under a count. */
function ChatChildrenList({ agents }: { agents: ChatChild[] }) {
  const active = useMemo(() => agents.filter((a) => isActiveState(a.state)), [agents])
  const finished = useMemo(() => agents.filter((a) => !isActiveState(a.state)), [agents])
  // With work in play, what's done is history: folded. With nothing else, it is the news.
  const [finishedOpen, setFinishedOpen] = useState(active.length === 0)
  const [showAll, setShowAll] = useState(false)
  const shownFinished = showAll ? finished : finished.slice(0, FINISHED_PREVIEW)

  return (
    <>
      {active.length > 0 && (
        <div className={ROWS}>
          {active.map((child) => <ChildRow key={child.key} child={child} />)}
        </div>
      )}
      {finished.length > 0 && (
        <>
          <div className={cn(INDENT, 'flex h-6 items-center', active.length > 0 && 'mt-1')}>
            <button
              onClick={() => setFinishedOpen((v) => !v)}
              aria-expanded={finishedOpen}
              className="relative flex min-w-0 flex-1 items-center text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRight className={cn('absolute -left-4 h-3 w-3 shrink-0 transition-transform', finishedOpen && 'rotate-90')} />
              <FormattedMessage id="editor.session.agentsFinished" defaultMessage="Finished {count}" values={{ count: finished.length }} />
            </button>
          </div>
          {finishedOpen && (
            <div className={ROWS}>
              {shownFinished.map((child) => <ChildRow key={child.key} child={child} />)}
              {finished.length > shownFinished.length && (
                <button
                  onClick={() => setShowAll(true)}
                  className="py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <FormattedMessage id="editor.session.showMore" defaultMessage="Show more" />
                </button>
              )}
            </div>
          )}
        </>
      )}
    </>
  )
}

function ChildRow({ child }: { child: ChatChild }) {
  const intl = useIntl()
  const openLabel = intl.formatMessage({ id: 'assistant.coding.openConversation', defaultMessage: 'Open conversation' })
  // The same "agent · model" the thread's card shows for it.
  const model = child.modelId && child.modelId !== 'default' ? child.modelId : undefined
  // Working in a workspace of its own: its changes are on that branch, so say which.
  const workspace = useOtherWorkspaceName(child.workspaceId)
  const who = [codingAgentName(child.providerId), model, workspace].filter(Boolean).join(' · ')

  return (
    <div className={ROW}>
      <div className="flex items-center gap-2">
        <RowDot className={CHILD_DOT[child.state]} />
        <button
          onClick={() => void openChildChat(child)}
          title={`${openLabel}: ${child.title}`}
          className="min-w-0 flex-1 truncate text-left text-foreground/85 transition-colors hover:text-foreground"
        >
          {child.title}
        </button>
        <span className="max-w-[45%] shrink-0 truncate text-[11px] text-muted-foreground/50" title={who}>{who}</span>
      </div>
      {child.detail && (
        <div className="line-clamp-2 text-xs text-status-error" title={child.detail}>
          {child.detail}
        </div>
      )}
      {child.pending.length > 0 && (
        <div className="mt-1.5 pb-1">
          <ChildPendingInput childChatId={child.childChatId} pending={child.pending} onOpen={() => void openChildChat(child)} />
        </div>
      )}
    </div>
  )
}
