import type { CSSProperties, ReactNode } from 'react'

type SocialLinksVariant = 'navbar' | 'cta'

type SocialLink = {
  href: string
  label: string
  icon: (size: number) => ReactNode
}

const links: SocialLink[] = [
  {
    href: 'https://discord.gg/2BuvC6v3B',
    label: 'Discord',
    icon: (size) => <DiscordIcon size={size} />,
  },
  {
    href: 'https://github.com/Nickqiaoo/Operon',
    label: 'GitHub',
    icon: (size) => <GitHubIcon size={size} />,
  },
  {
    href: 'https://x.com/operon_ai',
    label: 'X',
    icon: (size) => <XIcon size={size} />,
  },
]

export function SocialLinks({ variant = 'navbar' }: { variant?: SocialLinksVariant }) {
  const cta = variant === 'cta'
  const iconSize = cta ? 18 : 18
  const containerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: cta ? 10 : 32,
  }

  const linkStyle: CSSProperties = cta
    ? {
        width: 40,
        height: 40,
        borderRadius: 12,
        color: 'rgba(255,255,255,0.46)',
        background: 'rgba(255,255,255,0.055)',
        border: '1px solid rgba(255,255,255,0.08)',
        cursor: 'pointer',
        transition: 'color 0.3s, background 0.3s, border-color 0.3s, transform 0.3s',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }
    : {
        color: 'rgba(255,255,255,0.4)',
        cursor: 'pointer',
        transition: 'color 0.3s',
        display: 'flex',
        alignItems: 'center',
      }

  return (
    <div style={containerStyle} aria-label="Social links">
      {links.map((link) => (
        <a
          key={link.label}
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          style={linkStyle}
          onMouseEnter={(event) => {
            event.currentTarget.style.color = 'rgba(255,255,255,0.86)'
            if (cta) {
              event.currentTarget.style.background = 'rgba(255,255,255,0.09)'
              event.currentTarget.style.borderColor = 'rgba(255,255,255,0.14)'
              event.currentTarget.style.transform = 'translateY(-1px)'
            }
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = cta ? 'rgba(255,255,255,0.46)' : 'rgba(255,255,255,0.4)'
            if (cta) {
              event.currentTarget.style.background = 'rgba(255,255,255,0.055)'
              event.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
              event.currentTarget.style.transform = 'translateY(0)'
            }
          }}
          aria-label={link.label}
        >
          {link.icon(iconSize)}
        </a>
      ))}
    </div>
  )
}

function DiscordIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  )
}

function GitHubIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  )
}

function XIcon({ size }: { size: number }) {
  return (
    <svg width={size - 2} height={size - 2} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}
