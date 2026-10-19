import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { FormattedMessage, useIntl } from 'react-intl'
import { Folder, Hash, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useChannelStore } from '@/stores/channel-store'
import { useProjectStore } from '@/stores/project-store'
import { ChannelChat } from './ChannelChat'
import { MemberManageDialog } from './MemberManageDialog'

interface ChannelsViewProps {
  /** One project's channels, or null for every project's (grouped by project). */
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
 * Every project's channels in one place: a list grouped by project on the left,
 * the open conversation beside it. A channel still lives in a project — the
 * agents it summons work in that project's repo — so creating one names it.
 */
export function ChannelsView({ projectFilter, focus, onFocusConsumed, onOpenTask, newChannelOpen, onNewChannelOpenChange }: ChannelsViewProps) {
  const intl = useIntl()
  const channels = useChannelStore((s) => s.channels)
  const activeChannelId = useChannelStore((s) => s.activeChannelId)
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel)
  const deleteChannel = useChannelStore((s) => s.deleteChannel)
  const projects = useProjectStore((s) => s.projects)
  const [creatingIn, setCreatingIn] = useState<number | null>(null)
  const [showMembers, setShowMembers] = useState(false)
  const [focusMessageId, setFocusMessageId] = useState<number | null>(null)

  // Projects with channels, in the sidebar's order. A project picked in the filter
  // shows even while empty, so its "+" is there to start one.
  const groups = useMemo(() => {
    const visible = projectFilter == null ? projects : projects.filter((p) => p.id === projectFilter)
    return visible
      .map((p) => ({ project: p, channels: channels.filter((c) => c.projectId === p.id) }))
      .filter((g) => g.channels.length > 0 || g.project.id === projectFilter)
  }, [projects, channels, projectFilter])

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

  const remove = async (channelId: number) => {
    try {
      await deleteChannel(channelId)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete channel')
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* The page's own list, on the page's surface: in the sidebar's color it read as a
          second sidebar beside the real one. */}
      <div className="flex w-48 shrink-0 flex-col border-r border-border/50 dark:border-border/35">
        <div className="scroll-fade-y min-h-0 flex-1 space-y-3 overflow-y-auto p-2 pt-3">
          {groups.length === 0 && (
            <div className="mx-1 mt-2 rounded-lg border border-dashed border-border/50 px-3 py-4 text-center text-xs text-muted-foreground dark:border-border/35">
              <FormattedMessage id="channel.noChannels" defaultMessage="No channels yet" />
            </div>
          )}
          {groups.map(({ project, channels: list }) => (
            <div key={project.id} className="group/project">
              <div className="flex items-center gap-1.5 px-2 pb-1">
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" strokeWidth={1.5} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground/80">{project.name}</span>
                <button
                  type="button"
                  onClick={() => setCreatingIn(project.id)}
                  className="flex size-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent-hover hover:text-foreground focus-visible:opacity-100 group-hover/project:opacity-100"
                  title={intl.formatMessage({ id: 'channel.newChannelIn', defaultMessage: 'New channel in {project}' }, { project: project.name })}
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>

              {creatingIn === project.id && (
                <InlineChannelName
                  projectId={project.id}
                  onDone={(channelId) => {
                    setCreatingIn(null)
                    if (channelId != null) setActiveChannel(channelId)
                  }}
                />
              )}

              <div className="space-y-0.5">
                {list.map((channel) => (
                  <div key={channel.id} className="group/row relative flex items-center">
                    <button
                      type="button"
                      onClick={() => setActiveChannel(channel.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
                        activeChannelId === channel.id
                          ? 'bg-row-selected font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-row-hover hover:text-foreground',
                      )}
                    >
                      <Hash className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(channel.id)}
                      className="absolute right-1 rounded-md p-1 text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive group-hover/row:opacity-100"
                      title={intl.formatMessage({ id: 'channel.deleteChannel', defaultMessage: 'Delete channel' })}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        {activeChannel ? (
          <ChannelChat
            key={activeChannel.id}
            channelId={activeChannel.id}
            onManageMembers={() => setShowMembers(true)}
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

      {showMembers && activeChannel && (
        <MemberManageDialog channel={activeChannel} onClose={() => setShowMembers(false)} />
      )}
    </div>
  )
}

/** Name a new channel right under its project's heading. */
function InlineChannelName({ projectId, onDone }: { projectId: number; onDone: (channelId: number | null) => void }) {
  const intl = useIntl()
  const createChannel = useChannelStore((s) => s.createChannel)
  const [name, setName] = useState('')

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      const channel = await createChannel(projectId, trimmed)
      onDone(channel.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create channel')
    }
  }

  return (
    <div className="px-1 pb-1">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit()
          if (e.key === 'Escape') onDone(null)
        }}
        onBlur={() => {
          if (!name.trim()) onDone(null)
        }}
        placeholder={intl.formatMessage({ id: 'channel.newChannelPlaceholder', defaultMessage: 'channel-name' })}
        className="w-full rounded-lg border border-border/50 bg-background px-2 py-1 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-border dark:border-border/35"
      />
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
