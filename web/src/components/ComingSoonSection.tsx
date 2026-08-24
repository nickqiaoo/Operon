import { useIsMobile } from '../hooks/useIsMobile'
import { useIsCompactViewport } from '../hooks/useIsCompactViewport'
import { getDownloadHref, redirectToDownload } from '../lib/download'
import { Footer } from './Footer'
import { SocialLinks } from './SocialLinks'
import appStoreBadge from '../assets/app-store-badge.svg'

export function ComingSoonSection() {
  const mobile = useIsMobile()
  const compactViewport = useIsCompactViewport()
  const scrollableViewport = mobile || compactViewport
  const downloadHref = getDownloadHref('bottom_cta')
  const appUrl = import.meta.env.VITE_APP_URL ?? 'https://app.operon.chatcode.top/'

  return (
    <section
      style={{
        position: 'relative',
        height: '100%',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {/* Background glow */}
      <div
        style={{
          position: 'absolute',
          width: 900,
          height: 900,
          borderRadius: '50%',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'radial-gradient(circle, rgba(139,92,246,0.05) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      <div data-scrollable style={{
        width: '90vw',
        maxWidth: 720,
        ...(scrollableViewport
          ? {
              height: '100%',
              paddingTop: mobile ? 52 : 96,
              paddingBottom: mobile ? 0 : 56,
              overflow: 'auto',
              ...(mobile
                ? {
                    display: 'flex',
                    flexDirection: 'column',
                  }
                : {}),
            }
          : {}),
      }}>
        <div
          style={mobile
            ? {
                flex: '1 0 auto',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                paddingTop: 24,
                paddingBottom: 32,
              }
            : undefined}
        >
          {/* Headline */}
          <div style={{ textAlign: 'center', marginBottom: mobile ? 36 : 56 }}>
            <h2
              style={{
                fontSize: mobile ? 36 : 60,
                fontWeight: 600,
                color: 'rgba(255,255,255,0.92)',
                lineHeight: 1.1,
                letterSpacing: '-0.025em',
                marginBottom: mobile ? 14 : 22,
              }}
            >
              Ready when you are.
            </h2>
            <p
              style={{
                fontSize: mobile ? 14 : 19,
                lineHeight: 1.7,
                color: 'rgba(255,255,255,0.35)',
                fontWeight: 300,
                maxWidth: 520,
                margin: '0 auto',
              }}
            >
              Install Operon and start running agents in minutes.
            </p>
          </div>

          {/* CTAs */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: mobile ? 10 : 12,
                flexWrap: 'wrap',
                maxWidth: '100%',
              }}
            >
              <a
                href={downloadHref}
                onClick={(event) => {
                  window.gtag?.('event', 'click_download', { event_category: 'engagement', event_label: 'bottom_cta' })
                  event.preventDefault()
                  void redirectToDownload('bottom_cta')
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  minWidth: mobile ? 148 : 184,
                  padding: mobile ? '14px 22px' : '16px 34px',
                  borderRadius: 14,
                  background: 'rgba(255,255,255,0.1)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: '#fff',
                  fontSize: mobile ? 15 : 16,
                  fontWeight: 600,
                  letterSpacing: '-0.01em',
                  textDecoration: 'none',
                  cursor: 'pointer',
                  transition: 'all 0.3s',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.15)'
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'
                  e.currentTarget.style.transform = 'translateY(-2px)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'
                  e.currentTarget.style.transform = 'translateY(0)'
                }}
              >
                <DownloadIcon />
                Download
              </a>

              <a
                href={appUrl}
                onClick={() => {
                  window.gtag?.('event', 'click_open_app', { event_category: 'engagement', event_label: 'bottom_cta' })
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  minWidth: mobile ? 148 : 184,
                  padding: mobile ? '14px 22px' : '16px 34px',
                  borderRadius: 14,
                  background: '#fff',
                  border: '1px solid #fff',
                  color: '#050505',
                  fontSize: mobile ? 15 : 16,
                  fontWeight: 700,
                  letterSpacing: '-0.01em',
                  textDecoration: 'none',
                  cursor: 'pointer',
                  transition: 'all 0.3s',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.86)'
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.86)'
                  e.currentTarget.style.transform = 'translateY(-2px)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = '#fff'
                  e.currentTarget.style.borderColor = '#fff'
                  e.currentTarget.style.transform = 'translateY(0)'
                }}
              >
                Open app
                <OpenAppIcon />
              </a>
            </div>

            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.2)', fontWeight: 300 }}>
              Available for macOS
            </span>

            {/*
              Mobile clients. The iOS app is on the App Store, while Android
              ships as a signed APK served from this site.
            */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: mobile ? 12 : 18,
                flexWrap: 'wrap',
                paddingTop: 4,
              }}
            >
              <a
                href={ANDROID_APK_URL}
                onClick={() => {
                  window.gtag?.('event', 'click_download_android', {
                    event_category: 'engagement',
                    event_label: 'bottom_cta',
                  })
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  fontSize: 13,
                  color: 'rgba(255,255,255,0.5)',
                  textDecoration: 'none',
                  transition: 'color 0.25s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'rgba(255,255,255,0.85)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'rgba(255,255,255,0.5)'
                }}
              >
                <AndroidIcon />
                Download for Android (APK)
              </a>

              {/* Official Apple badge; per Apple guidelines it must not be restyled. */}
              <a
                href={IOS_APP_STORE_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  window.gtag?.('event', 'click_download_ios', {
                    event_category: 'engagement',
                    event_label: 'bottom_cta',
                  })
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  transition: 'opacity 0.25s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '0.85'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '1'
                }}
              >
                <img
                  src={appStoreBadge}
                  alt="Download on the App Store"
                  style={{ height: 40, display: 'block' }}
                />
              </a>
            </div>

            {mobile && <SocialLinks variant="cta" />}
          </div>
        </div>

        {/* Footer inline on mobile */}
        {mobile && (
          <div style={{ marginTop: 'auto', flexShrink: 0 }}>
            <Footer />
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * Versioned filename on purpose: the URL changes with every release, so a CDN
 * or a browser that cached the previous build can never hand someone a stale
 * APK. Update this and drop the new file into `public/download/` together.
 */
const ANDROID_APK_URL = '/download/operon-1.0.4.apk'
const IOS_APP_STORE_URL = 'https://apps.apple.com/us/app/operon-ai/id6797370866'

function AndroidIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.6 9.48l1.84-3.18a.4.4 0 0 0-.7-.4l-1.87 3.23a11.4 11.4 0 0 0-9.74 0L5.26 5.9a.4.4 0 1 0-.7.4L6.4 9.48A10.9 10.9 0 0 0 1 18h22a10.9 10.9 0 0 0-5.4-8.52M7 15.25a1 1 0 1 1 1-1 1 1 0 0 1-1 1m10 0a1 1 0 1 1 1-1 1 1 0 0 1-1 1" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function OpenAppIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  )
}
