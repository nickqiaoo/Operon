import { useState } from 'react'
import { CircleAlert, ExternalLinkIcon, Loader2 } from 'lucide-react'
import { FormattedMessage } from 'react-intl'
import { needsConversationToAnswer, type PendingInputSummary } from '@shared/pending-input'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { api } from '@/lib/api'
import { useChatPendingInputStore } from '@/stores/chat-pending-input-store'

/**
 * What the child chat is blocked on, answerable from the parent (its card in the
 * thread, and its row in the Session panel's Agents).
 *
 * The child runs in a conversation of its own that is usually not on screen, so
 * without this the parent just shows "running" while nothing happens. A plain approval is answered here, with
 * the request's own preview so it is not approved blind; a question or a plan
 * needs the child's own UI, so those only offer to open it. Answers go through
 * the same permission response as the child tab and the inbox, and the
 * live-status stream clears every surface once one of them answers.
 */
export function ChildPendingInput({
  childChatId,
  pending,
  onOpen,
}: {
  childChatId: number
  pending: PendingInputSummary[]
  onOpen: () => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)

  const decide = async (approvalId: string, outcome: 'allow' | 'deny') => {
    setBusyId(approvalId)
    try {
      const res = await api.aiPermissionResponse({ id: approvalId, outcome, chatId: childChatId })
      if (!res.success) {
        // Stale (answered elsewhere, or timed out): take the server's word for what is left.
        const fresh = await api.aiPendingApprovals(childChatId)
        useChatPendingInputStore.getState().set(childChatId, (fresh.approvals ?? []).map((a) => ({ userFacing: true, ...a })))
      }
    } catch (error) {
      console.warn('[external-agent] permission response failed', error)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <ItemGroup className="gap-2" onClick={(event) => event.stopPropagation()}>
      {pending.map((item) => (
        <Item key={item.approvalId} variant="outline" size="sm" className="bg-background">
          <ItemMedia variant="icon">
            <CircleAlert className="text-status-warn" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="font-normal">
              {item.toolName === 'AskUserQuestion' ? (
                <FormattedMessage id="editor.external.pendingQuestion" defaultMessage="The agent asked you a question" />
              ) : needsConversationToAnswer(item) ? (
                <FormattedMessage id="editor.external.pendingPlan" defaultMessage="The agent proposed a plan for review" />
              ) : (
                <FormattedMessage
                  id="editor.external.pendingApproval"
                  defaultMessage="Approval requested · {tool}"
                  values={{ tool: <span className="font-mono text-muted-foreground">{item.toolName}</span> }}
                />
              )}
            </ItemTitle>
            {item.inputPreview && !needsConversationToAnswer(item) ? (
              <ItemDescription className="truncate font-mono text-xs" title={item.inputPreview}>
                {item.inputPreview}
              </ItemDescription>
            ) : null}
          </ItemContent>
          <ItemActions>
            {needsConversationToAnswer(item) ? (
              <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={onOpen}>
                <ExternalLinkIcon className="h-3.5 w-3.5" />
                <FormattedMessage id="editor.external.openToAnswer" defaultMessage="Open" />
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={busyId === item.approvalId}
                  onClick={() => void decide(item.approvalId, 'deny')}
                >
                  <FormattedMessage id="editor.external.deny" defaultMessage="Deny" />
                </Button>
                <Button
                  size="sm"
                  className="h-8 gap-1.5"
                  disabled={busyId === item.approvalId}
                  onClick={() => void decide(item.approvalId, 'allow')}
                >
                  {busyId === item.approvalId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  <FormattedMessage id="editor.external.allow" defaultMessage="Allow" />
                </Button>
              </>
            )}
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  )
}
