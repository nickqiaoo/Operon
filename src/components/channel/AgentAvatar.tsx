import { Bot, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import claudeLogo from '@/assets/logos/claude.svg'
import openaiLogo from '@/assets/logos/openai.svg'
import opencodeLogo from '@/assets/logos/opencode.svg'
import kimiLogo from '@/assets/logos/kimi.svg'
import grokLogo from '@/assets/logos/grok.svg'

/**
 * Per-provider visual identity used in channel UIs so multiple agents are
 * distinguishable at a glance even when their names look similar.
 */
const PROVIDER_STYLE: Record<
  string,
  { logo: string; bg: string; ring: string; invertOnDark: boolean }
> = {
  'claude-code': {
    logo: claudeLogo,
    bg: 'bg-[#F5E6D8] dark:bg-[#3B2A1F]',
    ring: 'ring-[#D97757]/30',
    invertOnDark: false,
  },
  codex: {
    logo: openaiLogo,
    bg: 'bg-[#E4ECE6] dark:bg-[#1F2A23]',
    ring: 'ring-[#10A37F]/30',
    invertOnDark: true,
  },
  opencode: {
    logo: opencodeLogo,
    bg: 'bg-[#EEE9F7] dark:bg-[#2A2236]',
    ring: 'ring-[#7C5CD3]/30',
    invertOnDark: true,
  },
  kimi: {
    logo: kimiLogo,
    bg: 'bg-[#E8EBFF] dark:bg-[#222742]',
    ring: 'ring-[#5165FF]/30',
    invertOnDark: false,
  },
  grok: {
    logo: grokLogo,
    bg: 'bg-[#ECECEC] dark:bg-[#242424]',
    ring: 'ring-[#000000]/20 dark:ring-[#FFFFFF]/20',
    invertOnDark: true,
  },
}

const SIZE_CLASSES: Record<NonNullable<AgentAvatarProps['size']>, { box: string; img: string; icon: string }> = {
  sm: { box: 'w-6 h-6', img: 'w-3.5 h-3.5', icon: 'w-3 h-3' },
  md: { box: 'w-8 h-8', img: 'w-4 h-4', icon: 'w-4 h-4' },
  lg: { box: 'w-10 h-10', img: 'w-5 h-5', icon: 'w-5 h-5' },
}

interface AgentAvatarProps {
  /** Provider id from Agent.provider. Falls back to neutral icon if unknown. */
  provider?: string | null
  size?: 'sm' | 'md' | 'lg'
  className?: string
  ring?: boolean
}

export function AgentAvatar({ provider, size = 'md', className, ring = false }: AgentAvatarProps) {
  const style = provider ? PROVIDER_STYLE[provider] : undefined
  const dims = SIZE_CLASSES[size]
  if (!style) {
    return (
      <div
        className={cn(
          'flex-none flex items-center justify-center rounded-full bg-tint/15 text-tint',
          dims.box,
          ring && 'ring-1 ring-tint/20',
          className,
        )}
      >
        <Bot className={dims.icon} />
      </div>
    )
  }
  return (
    <div
      className={cn(
        'flex-none flex items-center justify-center rounded-full',
        style.bg,
        dims.box,
        ring && `ring-1 ${style.ring}`,
        className,
      )}
    >
      <img
        src={style.logo}
        alt=""
        className={cn(dims.img, style.invertOnDark && 'dark:invert dark:brightness-95')}
      />
    </div>
  )
}

export function UserAvatar({ size = 'md', className }: Pick<AgentAvatarProps, 'size' | 'className'>) {
  const dims = SIZE_CLASSES[size]
  return (
    <div
      className={cn(
        'flex-none flex items-center justify-center rounded-full bg-muted/60 text-muted-foreground',
        dims.box,
        className,
      )}
    >
      <User className={dims.icon} />
    </div>
  )
}
