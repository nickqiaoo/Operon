import { useIsMobile } from '../hooks/useIsMobile'

export function Footer() {
  const mobile = useIsMobile()

  return (
    <footer
      style={{
        ...(mobile
          ? {}
          : {
              position: 'fixed',
              bottom: 0,
              left: 0,
              right: 0,
              zIndex: 100,
              background: 'rgba(0,0,0,0.6)',
              backdropFilter: 'blur(20px)',
            }),
        borderTop: '1px solid rgba(255,255,255,0.04)',
        padding: mobile ? '16px 0 calc(16px + env(safe-area-inset-bottom))' : '16px 40px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: mobile ? 'space-between' : undefined,
        gap: mobile ? 18 : undefined,
        width: mobile ? '100%' : undefined,
      }}
    >
      {/* Left: copyright */}
      <div
        style={{
          fontSize: 12,
          color: 'rgba(255,255,255,0.25)',
          fontWeight: 400,
          flex: mobile ? '0 0 auto' : 1,
          whiteSpace: 'nowrap',
        }}
      >
        {mobile ? '© 2026 Operon.' : '© 2026 Operon. All rights reserved.'}
      </div>

      {/* Center: links */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        {[
          { label: 'Privacy', href: '/privacy' },
          { label: 'Terms', href: '/terms' },
        ].map((item) => (
          <a
            key={item.label}
            href={item.href}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 12,
              color: 'rgba(255,255,255,0.25)',
              cursor: 'pointer',
              transition: 'color 0.3s',
              textDecoration: 'none',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.6)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.25)')}
          >
            {item.label}
          </a>
        ))}
      </div>

      {!mobile && <div style={{ flex: 1 }} />}
    </footer>
  )
}
