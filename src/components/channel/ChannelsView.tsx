import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FormattedMessage, useIntl } from 'react-intl'
import { Folder, Hash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useChannelStore } from '@/stores/channel-store'
import { useProjectStore } from '@/stores/project-store'
import { ChannelChat } from './ChannelChat'

interface ChannelsViewProps {
  /** One project's channels, or null for every project's. */
  projectFilter: number | null
  /** Arrived from a task: open this channel at this message. */
  focus: { channelId: number; messageId: number | null } | null
  onFocusConsumed: () => void
  onOpenTask: (taskId: number) => void
  /** The "new channel" dialog, opened from the page's header. */
  newChannelOpen: boolean
  onNewChannelOpenChange: (open: boolean) => void
}

/**
 * The open channel's conversation. The list of channels to pick from is the
 * sidebar's panel on this page (`ChannelList`), floating out of the rail's #
 * when the panel is collapsed. A channel still lives in a project — the agents
 * it summons work in that project's repo — so creating one names it.
 */
export function ChannelsView({ projectFilter, focus, onFocusConsumed, onOpenTask, newChannelOpen, onNewChannelOpenChange }: ChannelsViewProps) {
  const channels = useChannelStore((s) => s.channels)
  const activeChannelId = useChannelStore((s) => s.activeChannelId)
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel)
  const [focusMessageId, setFocusMessageId] = useState<number | null>(null)

  const activeChannel = channels.find((c) => c.id === activeChannelId) ?? null

  // Narrowing the filter to another project closes a channel that's no longer listed.
  useEffect(() => {
    if (activeChannel && projectFilter != null && activeChannel.projectId !== projectFilter) {
      setActiveChannel(null)
    }
  }, [activeChannel, projectFilter, setActiveChannel])

  useEffect(() => {
    if (!focus) return
    setActiveChannel(focus.channelId)
    setFocusMessageId(focus.messageId)
    onFocusConsumed()
  }, [focus, setActiveChannel, onFocusConsumed])

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        {activeChannel ? (
          <ChannelChat
            key={activeChannel.id}
            channelId={activeChannel.id}
            onOpenTask={onOpenTask}
            focusMessageId={focusMessageId}
            onFocusConsumed={() => setFocusMessageId(null)}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-muted-foreground">
            <Hash className="mb-1 h-5 w-5 text-muted-foreground/60" />
            <p className="text-sm">
              <FormattedMessage id="channel.pickChannel" defaultMessage="Pick a channel" />
            </p>
            <p className="text-xs text-muted-foreground/70">
              <FormattedMessage
                id="channel.pickChannelHint"
                defaultMessage="Channels are where you talk with the agents working in a project."
              />
            </p>
          </div>
        )}
      </div>

      {newChannelOpen && (
        <NewChannelDialog
          defaultProjectId={projectFilter}
          onClose={() => onNewChannelOpenChange(false)}
          onCreated={(channelId) => {
            onNewChannelOpenChange(false)
            setActiveChannel(channelId)
          }}
        />
      )}

    </div>
  )
}

function NewChannelDialog({
  defaultProjectId,
  onClose,
  onCreated,
}: {
  defaultProjectId: number | null
  onClose: () => void
  onCreated: (channelId: number) => void
}) {
  const intl = useIntl()
  const projects = useProjectStore((s) => s.projects)
  const createChannel = useChannelStore((s) => s.createChannel)
  const [projectId, setProjectId] = useState(defaultProjectId != null ? String(defaultProjectId) : '')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || !projectId || saving) return
    setSaving(true)
    try {
      const channel = await createChannel(Number(projectId), trimmed)
      onCreated(channel.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create channel')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <FormattedMessage id="mobile.channel.newChannel" defaultMessage="New channel" />
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 pt-2">
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="h-9 w-full gap-1.5 border-border/50 bg-muted/30 text-sm">
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <SelectValue placeholder={intl.formatMessage({ id: 'task.new.project', defaultMessage: 'Project' })} />
            </SelectTrigger>
            <SelectContent position="popper" align="start" sideOffset={6}>
              {projects.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit()
            }}
            placeholder={intl.formatMessage({ id: 'channel.newChannelPlaceholder', defaultMessage: 'channel-name' })}
            className="h-9 w-full rounded-lg border border-border/50 bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-border dark:border-border/35"
          />
          <p className="text-xs text-muted-foreground">
            <FormattedMessage
              id="channel.newChannelProjectHint"
              defaultMessage="Agents in this channel work in the project's repository."
            />
          </p>
        </div>

        <DialogFooter>
          <Button size="sm" variant="ghost" className="h-8" onClick={onClose}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-8"
            disabled={!name.trim() || !projectId || saving}
            onClick={() => void submit()}
          >
            <FormattedMessage id="common.create" defaultMessage="Create" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
