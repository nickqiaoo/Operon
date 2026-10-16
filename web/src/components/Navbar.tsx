import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { getDownloadHref, redirectToDownload } from '../lib/download'
import { SocialLinks } from './SocialLinks'
import { Wordmark } from './Logo'
import { buttonPrimary, buttonSecondary, cn } from '../lib/styles'
import { APP_URL } from '../lib/links'

/** Section anchors; plain hash links so the browser's own smooth scrolling does the work. */
const ANCHORS = [
  { label: 'Agents', href: '#agents' },
  { label: 'Assistant', href: '#assistant' },
  { label: 'Tasks', href: '#tasks' },
  { label: 'Plugins', href: '#plugins' },
  { label: 'Mobile', href: '#mobile' },
]

export function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const downloadHref = getDownloadHref('navbar')

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 8)
    handleScroll()
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <nav
      className={cn(
        'fixed inset-x-0 top-0 z-[100] border-b backdrop-blur-xl transition-colors',
        scrolled ? 'border-border/50 bg-background/85' : 'border-transparent bg-background/0',
      )}
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 md:px-8">
        <a
          href="#top"
          className="flex shrink-0 items-center gap-2 text-foreground"
          onClick={(event) => {
            event.preventDefault()
            window.scrollTo({
              top: 0,
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            })
          }}
        >
          <Wordmark />
          <span className="hidden rounded border border-border/50 px-1.5 py-px text-[11px] text-muted-foreground sm:inline">
            Beta
          </span>
        </a>

        <div className="hidden flex-1 items-center justify-center gap-1 lg:flex">
          {ANCHORS.map((anchor) => (
            <a
              key={anchor.href}
              href={anchor.href}
              className="rounded-lg px-3 py-1.5 text-[13.5px] text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"
            >
              {anchor.label}
            </a>
          ))}
          <Link
            to="/docs"
            className="rounded-lg px-3 py-1.5 text-[13.5px] text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"
          >
            Docs
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <div className="mr-2 hidden md:block">
            <SocialLinks variant="navbar" />
          </div>
          <a
            href={downloadHref}
            className={cn(buttonSecondary, 'h-8 px-3 text-[13px]')}
            onClick={(event) => {
              window.gtag?.('event', 'click_download', { event_category: 'engagement', event_label: 'navbar' })
              event.preventDefault()
              void redirectToDownload('navbar')
            }}
          >
            <DownloadIcon />
            <span className="hidden min-[400px]:inline">Download</span>
          </a>
          <a
            href={APP_URL}
            className={cn(buttonPrimary, 'h-8 px-3 text-[13px]')}
            onClick={() => {
              window.gtag?.('event', 'click_open_app', { event_category: 'engagement', event_label: 'navbar' })
            }}
          >
            Open app
          </a>
        </div>
      </div>
    </nav>
  )
}

export function DownloadIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

export function ArrowIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  )
}
