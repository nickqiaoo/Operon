import type { CSSProperties } from 'react'
import { Bot, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { providerLogoName, providerLogoSrc } from '@/lib/provider-logos'

/**
 * Brand colour per logo (names from `provider-logos`), only where the brand itself has one:
 * the avatar's wash is this hue, lightened (or darkened) the same way for every provider.
 * Brands that are black and white — OpenAI today, OpenCode, Cursor, Grok, Copilot… — are
 * left out on purpose and get the neutral wash; don't make a colour up for them.
 */
const BRAND_HUE: Record<string, string> = {
  // Claude's coral.
  claude: '#D97757',
  // Google blue (Gemini; Antigravity has a logo of its own and stays neutral).
  google: '#4285F4',
  // DeepSeek's whale blue.
  deepseek: '#4D6BFE',
}

/**
 * One recipe for every wash, so no provider reads heavier than another: the hue at 18% over
 * the page in both themes (light → a pale tint, dark → a deep one). Neutral is the foreground
 * at 10%, which lands at about the same lightness.
 */
const WASH = 'bg-[color-mix(in_oklab,var(--agent-hue)_18%,var(--color-background))]'
const NEUTRAL_WASH = 'bg-[color-mix(in_oklab,var(--color-foreground)_10%,var(--color-background))]'
const RING = 'ring-1 ring-[color-mix(in_oklab,var(--agent-hue)_35%,transparent)]'
const NEUTRAL_RING = 'ring-1 ring-border/60'

const SIZE_CLASSES: Record<NonNullable<AgentAvatarProps['size']>, { box: string; img: string; icon: string }> = {
  sm: { box: 'w-6 h-6', img: 'w-3.5 h-3.5', icon: 'w-3 h-3' },
  md: { box: 'w-8 h-8', img: 'w-4 h-4', icon: 'w-4 h-4' },
  lg: { box: 'w-10 h-10', img: 'w-5 h-5', icon: 'w-5 h-5' },
}

interface AgentAvatarProps {
  /** Provider / agent id (`claude-code`, `codex`, `gemini`, …). Falls back to a neutral icon if unknown. */
  provider?: string | null
  size?: 'sm' | 'md' | 'lg'
  className?: string
  ring?: boolean
}

/**
 * An agent as an actor — who is doing the work (a task's assignee, a channel message, a
 * coding agent's row). The logo stays monochrome; the wash behind it tells agents apart.
 * Controls (model pickers, tabs, chips) use the bare `ProviderIcon` instead.
 */
export function AgentAvatar({ provider, size = 'md', className, ring = false }: AgentAvatarProps) {
  const dims = SIZE_CLASSES[size]
  const logo = providerLogoSrc(provider)
  if (!logo) {
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
  const hue = BRAND_HUE[providerLogoName(provider) ?? '']
  return (
    <div
      className={cn(
        'flex-none flex items-center justify-center rounded-full',
        hue ? WASH : NEUTRAL_WASH,
        dims.box,
        ring && (hue ? RING : NEUTRAL_RING),
        className,
      )}
      style={hue ? ({ '--agent-hue': hue } as CSSProperties) : undefined}
    >
      <img src={logo} alt="" className={cn(dims.img, 'dark:invert dark:brightness-95')} />
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
