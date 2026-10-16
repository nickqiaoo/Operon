import { Link } from 'react-router'
import { Wordmark } from './Logo'
import { SocialLinks } from './SocialLinks'
import { ANDROID_APK_URL, APP_URL, GITHUB_URL, IOS_APP_STORE_URL } from '../lib/links'

const COLUMNS: { title: string; links: { label: string; href: string; internal?: boolean; external?: boolean }[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'Download', href: '#download' },
      { label: 'Web app', href: APP_URL, external: true },
      { label: 'iOS app', href: IOS_APP_STORE_URL, external: true },
      { label: 'Android APK', href: ANDROID_APK_URL },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Docs', href: '/docs', internal: true },
      { label: 'Releases', href: `${GITHUB_URL}/releases`, external: true },
      { label: 'Support', href: '/support', internal: true },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy', href: '/privacy', internal: true },
      { label: 'Terms', href: '/terms', internal: true },
    ],
  },
]

const linkClass = 'text-[13px] text-muted-foreground transition-colors hover:text-foreground'

export function Footer() {
  return (
    <footer className="border-t border-border/40 bg-sidebar">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 pt-12 pb-[calc(2.5rem+env(safe-area-inset-bottom))] md:grid-cols-[1.4fr_repeat(3,1fr)] md:px-8">
        <div>
          <Wordmark size="sm" />
          <p className="mt-3 max-w-xs text-[13px] leading-[1.6] text-muted-foreground">
            One interface for every coding agent.
          </p>
          <div className="mt-4 -ml-2">
            <SocialLinks variant="navbar" />
          </div>
        </div>

        {COLUMNS.map((column) => (
          <div key={column.title}>
            <div className="text-[13px] font-medium text-foreground">{column.title}</div>
            <ul className="mt-3 space-y-2">
              {column.links.map((link) => (
                <li key={link.label}>
                  {link.internal ? (
                    <Link to={link.href} className={linkClass}>
                      {link.label}
                    </Link>
                  ) : (
                    <a
                      href={link.href}
                      className={linkClass}
                      {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    >
                      {link.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border/40">
        <div className="mx-auto max-w-6xl px-4 py-5 text-[12px] text-muted-foreground md:px-8">
          © 2026 Operon. All rights reserved.
        </div>
      </div>
    </footer>
  )
}
