import { useEffect, useMemo, useRef, useState } from 'react'
import { FormattedMessage } from 'react-intl'
import { cn } from '@/lib/utils'
import { AgentAvatar } from './AgentAvatar'
import type { Agent } from '@/types/channel'

/**
 * Detect whether the textarea caret is currently inside an `@mention` token.
 *
 * A mention token starts with `@` that is either at the very beginning of the
 * string or directly preceded by whitespace. It ends at the caret if everything
 * between `@` and the caret is non-whitespace. Returns the query (text after
 * `@`) and the index where `@` lives, or null if the caret is not in a token.
 */
export function detectMentionToken(
  text: string,
  caret: number,
): { atIndex: number; query: string } | null {
  const before = text.slice(0, caret)
  const atIndex = before.lastIndexOf('@')
  if (atIndex < 0) return null
  if (atIndex > 0) {
    const prev = before[atIndex - 1]
    if (prev && !/\s/.test(prev)) return null
  }
  const query = before.slice(atIndex + 1)
  if (/\s/.test(query)) return null
  return { atIndex, query }
}

interface MentionPickerProps {
  agents: Agent[]
  query: string
  selectedIndex: number
  onSelect: (agent: Agent) => void
  onHoverIndex: (index: number) => void
}

export function MentionPicker({
  agents,
  query,
  selectedIndex,
  onSelect,
  onHoverIndex,
}: MentionPickerProps) {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep selected row in view as user arrows through the list.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const el = list.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (agents.length === 0) {
    return (
      <div className="absolute bottom-full left-0 mb-2 w-64 rounded-xl border border-border/60 bg-popover shadow-float px-3 py-2 text-xs text-muted-foreground">
        {query ? (
          <FormattedMessage
            id="channel.mention.noMatchQuery"
            defaultMessage="No matching members for <q>@{query}</q>"
            values={{ query, q: (chunks) => <span className="font-mono">{chunks}</span> }}
          />
        ) : (
          <FormattedMessage id="channel.mention.noMatch" defaultMessage="No matching members" />
        )}
      </div>
    )
  }

  return (
    <div className="absolute bottom-full left-0 mb-2 w-64 max-h-56 overflow-hidden rounded-xl border border-border/60 bg-popover shadow-float">
      <div ref={listRef} className="max-h-56 overflow-y-auto">
        {agents.map((agent, idx) => (
          <button
            key={agent.id}
            type="button"
            onMouseEnter={() => onHoverIndex(idx)}
            onMouseDown={(e) => {
              // Prevent textarea from losing focus before we insert.
              e.preventDefault()
              onSelect(agent)
            }}
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors',
              idx === selectedIndex ? 'bg-tint/10 text-tint' : 'text-foreground hover:bg-muted/40',
            )}
          >
            <AgentAvatar provider={agent.provider} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{agent.name}</div>
              <div className="truncate text-[10px] text-muted-foreground/70">
                {agent.provider} · {agent.model}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

export function useMentionMatches(agents: Agent[], query: string): Agent[] {
  return useMemo(() => {
    const q = query.toLowerCase()
    if (!q) return agents.slice(0, 8)
    return agents
      .filter((a) => a.name.toLowerCase().includes(q))
      .sort((a, b) => {
        // Prefix matches first, then substring matches.
        const ap = a.name.toLowerCase().startsWith(q)
        const bp = b.name.toLowerCase().startsWith(q)
        if (ap !== bp) return ap ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .slice(0, 8)
  }, [agents, query])
}

export function useMentionState() {
  return useState<{ open: boolean; query: string; atIndex: number; selectedIndex: number }>({
    open: false,
    query: '',
    atIndex: -1,
    selectedIndex: 0,
  })
}
