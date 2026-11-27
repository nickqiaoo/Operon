import { ResponsiveDialog } from '@/components/mobile/ResponsiveDialog'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { FormattedMessage } from 'react-intl'
import { Bot, Check, Loader2, User, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
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
    void loadMembers(channel.id).catch(() => toast.error('Failed to load channel members'))
  }, [channel.id, loadMembers])

  const channelMembers = members[channel.id] ?? EMPTY_MEMBERS
  const serverAgentIds = useMemo(
    () => new Set(channelMembers.map((m) => m.agentId)),
    [channelMembers],
  )

  // Preserve only explicit choices while the membership request refreshes.
  const [choices, setChoices] = useState(new Map<number, boolean>())
  const selectedIds = new Set(serverAgentIds)
  for (const [id, selected] of choices) {
    if (selected) selectedIds.add(id)
    else selectedIds.delete(id)
  }

  const toggle = (id: number) => {
    setChoices((prev) => new Map(prev).set(id, !(prev.get(id) ?? serverAgentIds.has(id))))
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update channel members')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ResponsiveDialog open onClose={onClose} className="max-h-[70vh] max-w-sm overflow-hidden flex flex-col">
      <DialogHeader className="px-1 pt-1 pb-2 flex flex-row items-center justify-between shrink-0">
        <div>
          <DialogTitle>
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
        <Button aria-label="Close" variant="ghost" size="icon" className="size-11 md:size-7 rounded-md text-muted-foreground hover:text-foreground" onClick={onClose}>
          <XIcon className="h-4 w-4" />
        </Button>
      </DialogHeader>

      <div className="min-h-0 overflow-y-auto -mx-6 px-6">
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
                disabled={saving || !members[channel.id]}
                aria-pressed={isSelected}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-row-hover transition-colors text-left disabled:opacity-60"
              >
                <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 border transition-colors ${
                  isSelected ? 'bg-tint border-tint' : 'border-muted-foreground/40'
                }`}>
                  {isSelected && <Check className="w-3 h-3 text-tint-fg" strokeWidth={3} />}
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
      </div>

      <DialogFooter>
        <Button size="sm" variant="secondary" onClick={() => void handleDone()} disabled={saving} className="h-8 gap-1.5">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          <FormattedMessage id="common.done" defaultMessage="Done" />
        </Button>
      </DialogFooter>
    </ResponsiveDialog>
  )
}
