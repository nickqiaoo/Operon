import { useState } from 'react'
import { toast } from 'sonner'
import { FormattedMessage, useIntl } from 'react-intl'
import { Plus, Hash, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channel-store'

export const ROW =
  'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors text-left text-muted-foreground hover:bg-accent hover:text-accent-foreground'

interface ChannelMenuProps {
  projectId: number
  /** A channel was picked, or just created. */
  onOpenChannel: (channelId: number) => void
}

/**
 * The project's channels, out of the way behind one toolbar button: the board is
 * what the page is for, a channel is somewhere you drop in. (Agents have a button
 * of their own beside it: {@link AgentMenu}.)
 */
export function ChannelMenu({ projectId, onOpenChannel }: ChannelMenuProps) {
  const intl = useIntl()
  const channels = useChannelStore((s) => s.channels)
  const activeChannelId = useChannelStore((s) => s.activeChannelId)
  const createChannel = useChannelStore((s) => s.createChannel)
  const deleteChannel = useChannelStore((s) => s.deleteChannel)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const projectChannels = channels.filter((c) => c.projectId === projectId)

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      const channel = await createChannel(projectId, name)
      setNewName('')
      setCreating(false)
      onOpenChannel(channel.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create channel')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { void handleCreate() }
    if (e.key === 'Escape') {
      // Only the field: the popover stays open.
      e.preventDefault()
      setCreating(false)
      setNewName('')
    }
  }

  return (
    <div className="flex max-h-[min(70vh,520px)] flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-1.5">
        <div>
          <div className="flex items-center justify-between px-2 pb-1 pt-1">
            <span className="text-xs font-semibold text-muted-foreground"><FormattedMessage id="channel.section.channels" defaultMessage="Channels" /></span>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={intl.formatMessage({ id: 'mobile.channel.newChannel', defaultMessage: 'New channel' })}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {creating && (
            <div className="px-1 pb-1">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={() => { if (!newName.trim()) setCreating(false) }}
                placeholder={intl.formatMessage({ id: 'channel.newChannelPlaceholder', defaultMessage: 'channel-name' })}
                className="w-full rounded-lg border border-border/50 bg-background px-2 py-1 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-border dark:border-border/35"
              />
            </div>
          )}

          <div className="space-y-0.5">
            {projectChannels.length === 0 && !creating && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground/60">
                <FormattedMessage id="channel.noChannels" defaultMessage="No channels yet" />
              </div>
            )}
            {projectChannels.map((channel) => (
              <div key={channel.id} className="group relative flex items-center">
                <button
                  type="button"
                  onClick={() => onOpenChannel(channel.id)}
                  className={cn(ROW, activeChannelId === channel.id && 'bg-accent font-medium text-foreground')}
                >
                  <Hash className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void deleteChannel(channel.id)}
                  className="absolute right-1 rounded-md p-1 text-muted-foreground/50 opacity-0 transition-all hover:text-destructive group-hover:opacity-100"
                  title={intl.formatMessage({ id: 'channel.deleteChannel', defaultMessage: 'Delete channel' })}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

