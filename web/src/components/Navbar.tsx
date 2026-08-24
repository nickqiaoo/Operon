import { useNavigate } from 'react-router'
import { useIsMobile } from '../hooks/useIsMobile'
import { getDownloadHref, redirectToDownload } from '../lib/download'
import { SocialLinks } from './SocialLinks'

export function Navbar() {
  const navigate = useNavigate()
  const mobile = useIsMobile()
  const narrowMobile = useIsMobile(390)
  const downloadHref = getDownloadHref('navbar')
  // SaaS web app (the dist-web build of the main app), deployed separately. Set
  // VITE_APP_URL per deploy; the fallback is just a placeholder for local builds.
  const appUrl = import.meta.env.VITE_APP_URL ?? 'https://app.operon.chatcode.top/'

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
        gap: mobile ? 12 : 32,
        padding: mobile ? '0 12px' : '0 40px',
        height: mobile ? 52 : 64,
        background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(20px)',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: mobile ? 6 : 10, flexShrink: 0 }}>
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
        {!narrowMobile && (
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
      </div>

      {/* Nav links */}
      <div style={{ display: 'flex', alignItems: 'center', gap: mobile ? 8 : 32, minWidth: 0 }}>
        {!mobile && (
          <>
            <a
              onClick={() => navigate('/docs')}
              style={{
                fontSize: 14,
                color: 'rgba(255,255,255,0.4)',
                cursor: 'pointer',
                transition: 'color 0.3s',
                fontWeight: 400,
                textDecoration: 'none',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.8)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.4)')}
            >
              Docs
            </a>
          </>
        )}

        {/* Social icons */}
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
            padding: mobile ? (narrowMobile ? '6px 9px' : '6px 12px') : '8px 20px',
            cursor: 'pointer',
            transition: 'all 0.3s',
            display: 'flex',
            alignItems: 'center',
            gap: narrowMobile ? 0 : 8,
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
            padding: mobile ? '6px 11px' : '8px 20px',
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
