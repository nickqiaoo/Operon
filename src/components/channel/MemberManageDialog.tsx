import { useEffect, useMemo, useRef, useState } from 'react'
import { FormattedMessage } from 'react-intl'
import { Bot, Check, Loader2, User, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useChannelStore } from '@/stores/channel-store'
import type { Channel, ChannelMember } from '@/types/channel'

const EMPTY_MEMBERS: ChannelMember[] = []

interface MemberManageDialogProps {
  channel: Channel
  onClose: () => void
}

export function MemberManageDialog({ channel, onClose }: MemberManageDialogProps) {
  const agents = useChannelStore((s) => s.agents)
  const members = useChannelStore((s) => s.members)
  const loadMembers = useChannelStore((s) => s.loadMembers)
  const addMember = useChannelStore((s) => s.addMember)
  const removeMember = useChannelStore((s) => s.removeMember)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void loadMembers(channel.id)
  }, [channel.id, loadMembers])

  const channelMembers = members[channel.id] ?? EMPTY_MEMBERS
  const serverAgentIds = useMemo(
    () => new Set(channelMembers.map((m) => m.agentId)),
    [channelMembers],
  )

  // Local draft of selected agent ids — initialized from server state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const prevMembersRef = useRef(channelMembers)
  useEffect(() => {
    if (prevMembersRef.current === channelMembers) return
    prevMembersRef.current = channelMembers
    setSelectedIds(new Set(channelMembers.map((m) => m.agentId)))
  }, [channelMembers])

  const toggle = (agentId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(agentId)) {
        next.delete(agentId)
      } else {
        next.add(agentId)
      }
      return next
    })
  }

  const hasChanges = (() => {
    if (selectedIds.size !== serverAgentIds.size) return true
    for (const id of selectedIds) {
      if (!serverAgentIds.has(id)) return true
    }
    return false
  })()

  const handleDone = async () => {
    if (!hasChanges) {
      onClose()
      return
    }
    setSaving(true)
    try {
      // Add new members
      for (const agentId of selectedIds) {
        if (!serverAgentIds.has(agentId)) {
          await addMember(channel.id, agentId)
        }
      }
      // Remove deselected members
      for (const agentId of serverAgentIds) {
        if (!selectedIds.has(agentId)) {
          await removeMember(channel.id, agentId)
        }
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        className="max-h-[70vh] max-w-sm overflow-hidden flex flex-col"
        showCloseButton={false}
      >
        <DialogHeader className="px-1 pt-1 pb-2 flex flex-row items-center justify-between shrink-0">
          <div>
            <DialogTitle className="text-lg font-semibold tracking-tight">
              <FormattedMessage id="channel.members.title" defaultMessage="Members of #{name}" values={{ name: channel.name }} />
            </DialogTitle>
            <p className="text-xs text-muted-foreground/60 mt-0.5">
              <FormattedMessage
                id="channel.agentCount"
                defaultMessage="{count, plural, one {# agent} other {# agents}}"
                values={{ count: selectedIds.size }}
              />
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted/50 transition-colors" onClick={onClose}>
            <XIcon className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 -mx-6 px-6">
          <div className="space-y-1 pb-2">
            {agents.length === 0 && (
              <div className="text-xs text-muted-foreground/60 text-center py-4">
                <FormattedMessage id="channel.members.noAgents" defaultMessage="No agents yet. Create agents first." />
              </div>
            )}
            {agents.map((agent) => {
              const isSelected = selectedIds.has(agent.id)
              return (
                <button
                  key={agent.id}
                  onClick={() => toggle(agent.id)}
                  disabled={saving}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/40 transition-colors text-left disabled:opacity-60"
                >
                  <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 border transition-colors ${
                    isSelected ? 'bg-tint border-tint' : 'border-border/60'
                  }`}>
                    {isSelected && <Check className="w-3 h-3 text-white" />}
                  </div>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="flex items-center justify-center w-6 h-6 rounded-full bg-tint/15">
                      <Bot className="w-3.5 h-3.5 text-tint" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">{agent.name}</div>
                      <div className="text-xs text-muted-foreground/60 truncate">{agent.provider} · {agent.model}</div>
                    </div>
                  </div>
                </button>
              )
            })}

            {/* You (always shown) */}
            <div className="flex items-center gap-3 px-3 py-2 rounded-lg">
              <div className="w-5 h-5" />
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div className="flex items-center justify-center w-6 h-6 rounded-full bg-muted/60">
                  <User className="w-3.5 h-3.5 text-muted-foreground" />
                </div>
                <div className="text-sm text-muted-foreground">
                  <FormattedMessage id="channel.members.youAlways" defaultMessage="you (always)" />
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>

        <DialogFooter className="pt-4 mt-2 border-t border-border/60 shrink-0">
          <Button variant="secondary" onClick={() => void handleDone()} disabled={saving} className="w-full">
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            <FormattedMessage id="common.done" defaultMessage="Done" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
