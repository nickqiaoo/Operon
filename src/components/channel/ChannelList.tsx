import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FormattedMessage, useIntl } from 'react-intl'
import { Folder, Hash, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useChannelStore } from '@/stores/channel-store'
import { useProjectStore } from '@/stores/project-store'
import { isChannelsView } from '@/stores/app-shell-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { BOARD_PROJECT_FILTER_KEY, useProjectFilter } from '@/components/project/ProjectFilterSelect'
import { attentionOf, hasUnread, useChannelUnreadMap } from '@/lib/channel-queries'
import { UNREAD_CAP } from '@/types/channel'

interface ChannelListProps {
  /** On screen (panel out, or floating): loads the channels the first time. */
  shown: boolean
  /** A channel was picked: a floating list closes. */
  onNavigate?: () => void
}

/**
 * Every project's channels, grouped by project — the sidebar panel's content
 * on the Channels page, and what floats out of the rail's # when the panel is
 * collapsed. A channel lives in a project (its agents work in that repo), so
 * each project heading carries its own "new channel". Narrowed by the same
 * project filter as the page's header.
 */
export function ChannelList({ shown, onNavigate }: ChannelListProps) {
  const intl = useIntl()
  const channels = useChannelStore((s) => s.channels)
  const activeChannelId = useChannelStore((s) => s.activeChannelId)
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel)
  const deleteChannel = useChannelStore((s) => s.deleteChannel)
  const loadChannels = useChannelStore((s) => s.loadChannels)
  const projects = useProjectStore((s) => s.projects)
  const onChannelsPage = useNavigationStore((s) => isChannelsView(s.main))
  const showMain = useNavigationStore((s) => s.showMain)
  const [projectFilter] = useProjectFilter(BOARD_PROJECT_FILTER_KEY)
  const [creatingIn, setCreatingIn] = useState<number | null>(null)
  const unreadByChannel = useChannelUnreadMap()

  // Floating out over another page, nothing may have loaded them yet. Once is
  // enough: the Channels page reloads them on every visit.
  const loadedRef = useRef(false)
  useEffect(() => {
    if (!shown || loadedRef.current) return
    loadedRef.current = true
    loadChannels(null).catch(() => { loadedRef.current = false })
  }, [shown, loadChannels])

  // Projects with channels, in the sidebar's order. A project picked in the filter
  // shows even while empty, so its "+" is there to start one.
  const groups = useMemo(() => {
    const visible = projectFilter == null ? projects : projects.filter((p) => p.id === projectFilter)
    return visible
      .map((p) => ({ project: p, channels: channels.filter((c) => c.projectId === p.id) }))
      .filter((g) => g.channels.length > 0 || g.project.id === projectFilter)
  }, [projects, channels, projectFilter])

  const open = (channelId: number) => {
    setActiveChannel(channelId)
    if (!onChannelsPage) showMain({ kind: 'board', view: 'channels' })
    onNavigate?.()
  }

  const remove = async (channelId: number) => {
    try {
      await deleteChannel(channelId)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete channel')
    }
  }

  return (
    <>
      <div className="flex h-9 shrink-0 items-center pl-4 pr-3">
        <span className="heading-section">
          <FormattedMessage id="sidebar.channels" defaultMessage="Channels" />
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:!block [&>[data-slot=scroll-area-viewport]>div]:!min-w-0" viewportClassName="scroll-fade-y [--scroll-fade-gutter:0px]">
        <div className="space-y-2 pb-3">
          {groups.length === 0 && (
            <div className="mx-3 mt-2 rounded-lg border border-dashed border-border/50 px-3 py-4 text-center text-xs text-muted-foreground dark:border-border/35">
              <FormattedMessage id="channel.noChannels" defaultMessage="No channels yet" />
            </div>
          )}
          {groups.map(({ project, channels: list }) => (
            <div key={project.id} className="group/project px-2">
              <div className="relative mb-0.5 flex items-center gap-1.5 rounded-lg py-1 pl-2 pr-1 text-sm font-medium text-foreground/80 [@media(pointer:coarse)]:py-2">
                <Folder className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden />
                <span className="min-w-0 flex-1 truncate" title={project.name}>{project.name}</span>
                <button
                  type="button"
                  onClick={() => setCreatingIn(project.id)}
                  className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent-hover hover:text-foreground focus-visible:opacity-100 group-hover/project:opacity-100 [@media(hover:none)]:opacity-100"
                  title={intl.formatMessage({ id: 'channel.newChannelIn', defaultMessage: 'New channel in {project}' }, { project: project.name })}
                  aria-label={intl.formatMessage({ id: 'channel.newChannelIn', defaultMessage: 'New channel in {project}' }, { project: project.name })}
                >
                  <Plus className="size-3.5" strokeWidth={1.5} />
                </button>
              </div>

              {creatingIn === project.id && (
                <InlineChannelName
                  projectId={project.id}
                  onDone={(channelId) => {
                    setCreatingIn(null)
                    if (channelId != null) open(channelId)
                  }}
                />
              )}

              <div className="space-y-0.5">
                {list.map((channel) => {
                  const active = onChannelsPage && activeChannelId === channel.id
                  // The open channel is being read as it arrives; don't flash a count on it.
                  // What waits on you shows even there: reading doesn't settle it.
                  const entry = unreadByChannel.get(channel.id)
                  const attention = attentionOf(entry)
                  const unread = !active && hasUnread(entry)
                  const mainCount = entry?.unread ?? 0
                  return (
                    <div key={channel.id} className="group/row relative">
                      <button
                        type="button"
                        onClick={() => open(channel.id)}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex w-full min-w-0 items-center gap-2 rounded-lg py-1 pl-5 pr-8 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [@media(pointer:coarse)]:py-2',
                          active
                            ? 'bg-row-selected font-semibold text-foreground'
                            : unread || attention > 0
                              ? 'font-semibold text-foreground hover:bg-row-hover'
                              : 'font-medium text-foreground/70 hover:bg-row-hover hover:text-foreground',
                        )}
                      >
                        <Hash className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                        <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                        {/* Waiting on you: amber count. Else main-timeline messages get a
                            count; unread only in threads, a dot. Hidden on hover,
                            where the delete button takes this spot — at once, not
                            faded: both fading in the same spot showed them overlapping
                            for the length of the transition. */}
                        {(attention > 0 || unread) && (
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 group-hover/row:invisible group-has-[[data-delete]:focus-visible]/row:invisible">
                            {attention > 0 ? (
                              <span className="block min-w-4 rounded-full bg-accent-warm px-1 text-center text-[10px] font-medium leading-4 tabular-nums text-white">
                                {attention > 99 ? '99+' : attention}
                              </span>
                            ) : mainCount > 0 ? (
                              <span className="text-[11px] font-medium tabular-nums text-tint">
                                {mainCount >= UNREAD_CAP ? '99+' : mainCount}
                              </span>
                            ) : (
                              <span className="block size-1.5 rounded-full bg-tint" />
                            )}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(channel.id)}
                        data-delete
                        className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent-hover hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100"
                        title={intl.formatMessage({ id: 'channel.deleteChannel', defaultMessage: 'Delete channel' })}
                        aria-label={intl.formatMessage({ id: 'channel.deleteChannel', defaultMessage: 'Delete channel' })}
                      >
                        <Trash2 className="size-3.5" strokeWidth={1.5} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </>
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
    <div className="pb-1 pl-3">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit()
          if (e.key === 'Escape') {
            // The floating list closes on Escape too; this one is the input's.
            e.preventDefault()
            onDone(null)
          }
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
