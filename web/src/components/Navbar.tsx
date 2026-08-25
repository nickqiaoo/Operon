import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useIsMobile } from '../hooks/useIsMobile'
import { useScrollProgress } from '../hooks/useScrollProgress'
import { getDownloadHref, redirectToDownload } from '../lib/download'
import { SocialLinks } from './SocialLinks'

/**
 * Section anchors. These replace the twelve page-indicator dots on the right
 * edge — on a continuous page there is nothing to enumerate, but jumping
 * straight to a topic is still worth having. Plain hash links, so the browser's
 * own smooth scrolling and `scroll-padding-top` do the work.
 */
const ANCHORS = [
  { label: 'Agents', href: '#agents' },
  { label: 'Workflow', href: '#workflow' },
  { label: 'Channels', href: '#channels' },
  { label: 'Tasks', href: '#tasks' },
]

export function Navbar() {
  const navigate = useNavigate()
  const mobile = useIsMobile()
  const narrowMobile = useIsMobile(390)
  const hideAnchors = useIsMobile(1180)
  const progress = useScrollProgress()
  const [scrolled, setScrolled] = useState(false)
  const downloadHref = getDownloadHref('navbar')
  // SaaS web app (the dist-web build of the main app), deployed separately. Set
  // VITE_APP_URL per deploy; the fallback is just a placeholder for local builds.
  const appUrl = import.meta.env.VITE_APP_URL ?? 'https://app.operon.chatcode.top/'

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 8)
    handleScroll()
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <nav
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: mobile ? 12 : 28,
        padding: mobile ? '0 12px' : '0 40px',
        height: mobile ? 52 : 64,
        background: scrolled ? 'rgba(0,0,0,0.72)' : 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: `1px solid ${scrolled ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.04)'}`,
        transition: 'background 0.3s ease, border-color 0.3s ease',
      }}
    >
      {/* Reading progress — the long-page replacement for the page dots */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          bottom: -1,
          height: 1.5,
          width: `${progress * 100}%`,
          background: 'linear-gradient(90deg, rgba(99,102,241,0.5), rgba(167,139,250,0.9))',
          opacity: progress > 0.005 ? 1 : 0,
          transition: 'opacity 0.3s ease',
          pointerEvents: 'none',
        }}
      />

      {/* Logo */}
      <a
        href="#top"
        onClick={(event) => {
          event.preventDefault()
          window.scrollTo({
            top: 0,
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          })
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: mobile ? 6 : 10,
          flexShrink: 0,
          minWidth: 0,
          textDecoration: 'none',
        }}
      >
        <span
          style={{
            fontSize: mobile ? 15 : 18,
            fontWeight: 600,
            letterSpacing: '0.06em',
            color: 'rgba(255,255,255,0.9)',
            fontFamily: "'General Sans', sans-serif",
            textTransform: 'uppercase',
          }}
        >
          OPERON
        </span>
        {/* Decorative only — phones need the width for the two buttons */}
        {!mobile && (
          <span
            style={{
              fontSize: 11,
              color: 'rgba(255,255,255,0.25)',
              fontWeight: 500,
              padding: '2px 8px',
              borderRadius: 6,
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            Beta
          </span>
        )}
      </a>

      {/* Section anchors */}
      {!hideAnchors && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 26,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            justifyContent: 'center',
          }}
        >
          {ANCHORS.map((anchor) => (
            <a
              key={anchor.href}
              href={anchor.href}
              style={{
                fontSize: 13.5,
                color: 'rgba(255,255,255,0.4)',
                textDecoration: 'none',
                fontWeight: 400,
                transition: 'color 0.25s',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.85)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.4)')}
            >
              {anchor.label}
            </a>
          ))}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: mobile ? 8 : 22, minWidth: 0 }}>
        {!mobile && (
          <a
            onClick={() => navigate('/docs')}
            style={{
              fontSize: 13.5,
              color: 'rgba(255,255,255,0.4)',
              cursor: 'pointer',
              transition: 'color 0.25s',
              fontWeight: 400,
              textDecoration: 'none',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.85)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.4)')}
          >
            Docs
          </a>
        )}

        {!mobile && <SocialLinks variant="navbar" />}

        {/* Download button */}
        <a
          href={downloadHref}
          onClick={(event) => {
            window.gtag?.('event', 'click_download', { event_category: 'engagement', event_label: 'navbar' })
            event.preventDefault()
            void redirectToDownload('navbar')
          }}
          style={{
            textDecoration: 'none',
            fontSize: mobile ? 12 : 14,
            fontWeight: 500,
            color: '#fff',
            background: 'rgba(255,255,255,0.1)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: mobile ? 8 : 10,
            padding: mobile ? (narrowMobile ? '6px 9px' : '6px 12px') : '8px 18px',
            cursor: 'pointer',
            transition: 'all 0.3s',
            display: 'flex',
            alignItems: 'center',
            gap: narrowMobile ? 0 : 8,
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.15)'
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {!narrowMobile && 'Download'}
        </a>

        {/* Open the SaaS web app (separate deploy; see VITE_APP_URL) */}
        <a
          href={appUrl}
          onClick={() => {
            window.gtag?.('event', 'click_open_app', { event_category: 'engagement', event_label: 'navbar' })
          }}
          style={{
            textDecoration: 'none',
            fontSize: mobile ? 12 : 14,
            fontWeight: 600,
            color: '#000',
            background: '#fff',
            border: '1px solid #fff',
            borderRadius: mobile ? 8 : 10,
            padding: mobile ? '6px 11px' : '8px 18px',
            cursor: 'pointer',
            transition: 'all 0.3s',
            display: 'flex',
            alignItems: 'center',
            gap: mobile ? 0 : 8,
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.85)'
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.85)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#fff'
            e.currentTarget.style.borderColor = '#fff'
          }}
        >
          {narrowMobile ? 'Open' : 'Open app'}
          {!mobile && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          )}
        </a>
      </div>
    </nav>
  )
}
