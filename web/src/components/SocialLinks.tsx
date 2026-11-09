import type { ReactNode } from 'react'
import { GITHUB_URL } from '../lib/links'
import { cn } from '../lib/styles'

type SocialLinksVariant = 'navbar' | 'cta'

const links: { href: string; label: string; icon: (size: number) => ReactNode }[] = [
  { href: GITHUB_URL, label: 'GitHub', icon: (size) => <GitHubIcon size={size} /> },
]

export function SocialLinks({ variant = 'navbar' }: { variant?: SocialLinksVariant }) {
  const cta = variant === 'cta'

  return (
    <div className={cn('flex items-center', cta ? 'justify-center gap-2' : 'gap-1')} aria-label="Social links">
      {links.map((link) => (
        <a
          key={link.label}
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={link.label}
          className={cn(
            'inline-flex items-center justify-center text-muted-foreground transition-colors hover:text-foreground',
            cta
              ? 'h-9 w-9 rounded-lg border border-border/60 bg-background hover:bg-secondary-hover'
              : 'h-8 w-8 rounded-lg hover:bg-secondary-hover',
          )}
        >
          {link.icon(16)}
        </a>
      ))}
    </div>
  )
}

function GitHubIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  )
}
