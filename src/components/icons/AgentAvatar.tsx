import { Bot, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { providerLogoSrc } from '@/lib/provider-logos'

/**
 * No wash, no ring: an avatar is just the logo. A tinted disc behind it (brand coral, later a
 * neutral 10% grey) read as a badge stuck on the row and made the agent look heavier than its
 * name; the logo alone already says who it is. Don't put a fill back — not here, not at the call
 * site. Where an avatar has to mask something behind it (the task timeline's rail), the caller
 * adds `bg-background`, the page's own colour. The one exception is an overlapped face pile
 * (channel header `MemberStack`): stacking needs a disc to read, so that caller adds `bg-muted`.
 *
 * The box stays round and keeps its size so rows line up and `ring-*` cut-outs stay circular.
 */
const SIZE_CLASSES: Record<NonNullable<AgentAvatarProps['size']>, { box: string; img: string }> = {
  sm: { box: 'w-6 h-6', img: 'w-4 h-4' },
  md: { box: 'w-8 h-8', img: 'w-5 h-5' },
  lg: { box: 'w-10 h-10', img: 'w-7 h-7' },
}

interface AgentAvatarProps {
  /** Provider / agent id (`claude-code`, `codex`, `gemini`, …). Falls back to a neutral icon if unknown. */
  provider?: string | null
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

/**
 * An agent as an actor — who is doing the work (a task's assignee, a channel message, a
 * coding agent's row). The monochrome logo on nothing.
 * Controls (model pickers, tabs, chips) use `ProviderIcon` instead.
 */
export function AgentAvatar({ provider, size = 'md', className }: AgentAvatarProps) {
  const dims = SIZE_CLASSES[size]
  const logo = providerLogoSrc(provider)
  return (
    <div className={cn('flex-none flex items-center justify-center rounded-full', dims.box, className)}>
      {logo
        ? <img src={logo} alt="" className={cn(dims.img, 'object-contain dark:invert dark:brightness-95')} />
        : <Bot className={cn(dims.img, 'text-muted-foreground')} />}
    </div>
  )
}

export function UserAvatar({ size = 'md', className }: Pick<AgentAvatarProps, 'size' | 'className'>) {
  const dims = SIZE_CLASSES[size]
  return (
    <div className={cn('flex-none flex items-center justify-center rounded-full text-muted-foreground', dims.box, className)}>
      <User className={dims.img} />
    </div>
  )
}
