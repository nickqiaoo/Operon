import { useEffect, useMemo, useRef, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import type { Agent, ChannelMessage } from '@/types/channel'
import { AgentAvatar } from '@/components/icons/AgentAvatar'

/** Names spelled out before the rest collapse into "N others". */
const MAX_NAMES = 3
/** Faces in the pile before a "+N". */
const MAX_FACES = 3

/**
 * After an agent posts, its turn usually ends a moment later (it is wrapping
 * up), so it leaves the "working" line as soon as its message lands. If it is
 * still running once this has passed, it really kept working and comes back.
 */
const REPLY_GRACE_MS = 5000

/** Overlapped face pile, the same discs as the channel header's member stack. */
const STACK_DISC = 'size-5 bg-muted ring-2 ring-background'

/**
 * Who is on what was just said, as one quiet line at the end of the transcript:
 * a small face pile and "builder and luna-lead are working", shimmering. It is
 * deliberately not shaped like a message (no name row, no full-size avatar) —
 * it is a status, and it must not read as one more reply.
 *
 * Agents blocked on an approval are left out by the caller: the approval card
 * above the composer already says what they are waiting for.
 */
export function ChannelWorkingIndicator({ agents }: { agents: Agent[] }) {
  const intl = useIntl()
  if (agents.length === 0) return null

  const faces = agents.slice(0, MAX_FACES)
  const extraFaces = agents.length - faces.length
  const names = agents.length > MAX_NAMES
    ? [
        ...agents.slice(0, MAX_NAMES - 1).map((a) => a.name),
        intl.formatMessage(
          { id: 'channel.working.others', defaultMessage: '{count, plural, one {# other} other {# others}}' },
          { count: agents.length - (MAX_NAMES - 1) },
        ),
      ]
    : agents.map((a) => a.name)

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-2 pt-4 animate-in fade-in-0 duration-300 motion-reduce:animate-none md:px-3"
    >
      <div className="flex flex-none items-center -space-x-1.5">
        {faces.map((a) => (
          <AgentAvatar
            key={a.id}
            provider={a.provider}
            size="sm"
            className={`${STACK_DISC} [&>img]:size-3 [&>svg]:size-3`}
          />
        ))}
        {extraFaces > 0 && (
          <span className={`${STACK_DISC} flex flex-none items-center justify-center rounded-full text-[9px] font-semibold tabular-nums text-muted-foreground`}>
            +{extraFaces}
          </span>
        )}
      </div>
      <span className="min-w-0 truncate text-xs text-muted-foreground shimmer motion-reduce:shimmer-none">
        <FormattedMessage
          id="channel.working"
          defaultMessage="{names} {count, plural, one {is working} other {are working}}"
          values={{ names: intl.formatList(names, { type: 'conjunction' }), count: agents.length }}
        />
      </span>
    </div>
  )
}

/**
 * `workingIds` minus agents that just posted in the channel — see
 * REPLY_GRACE_MS. A hold is dropped once the agent stops working, so its next
 * turn shows straight away.
 */
export function useWorkingAfterReply(workingIds: number[], messages: ChannelMessage[]): number[] {
  const [held, setHeld] = useState<ReadonlyMap<number, number>>(() => new Map())
  const lastSeenId = useRef<number | null>(null)

  // Agents with a message newer than the last one seen. The first page of a
  // channel (lastSeen null) is history, not something just posted.
  useEffect(() => {
    const prevId = lastSeenId.current
    lastSeenId.current = messages.at(-1)?.id ?? null
    if (prevId == null) return
    const posted = messages.filter((m) => m.id > prevId && m.senderType === 'agent' && m.senderId != null)
    if (posted.length === 0) return
    const until = Date.now() + REPLY_GRACE_MS
    setHeld((prev) => {
      const next = new Map(prev)
      for (const m of posted) next.set(m.senderId!, until)
      return next
    })
  }, [messages])

  // Its turn ended: nothing left to hold back.
  useEffect(() => {
    setHeld((prev) => {
      const ended = [...prev.keys()].filter((id) => !workingIds.includes(id))
      if (ended.length === 0) return prev
      const next = new Map(prev)
      for (const id of ended) next.delete(id)
      return next
    })
  }, [workingIds])

  // Release each hold when its grace runs out.
  useEffect(() => {
    if (held.size === 0) return
    const soonest = Math.min(...held.values())
    const timer = setTimeout(() => {
      const now = Date.now()
      setHeld((prev) => new Map([...prev].filter(([, until]) => until > now)))
    }, Math.max(0, soonest - Date.now()))
    return () => clearTimeout(timer)
  }, [held])

  return useMemo(() => workingIds.filter((id) => !held.has(id)), [workingIds, held])
}
