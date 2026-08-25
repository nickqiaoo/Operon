import { useIsMobile } from '../hooks/useIsMobile'

/**
 * Sits at the end of the document now. It used to be `position: fixed` on
 * desktop — necessary when the body could not scroll, but on a continuous page
 * a permanently pinned footer just eats vertical space on every screen.
 */
export function Footer() {
  const mobile = useIsMobile()

  return (
    <footer
      style={{
        borderTop: '1px solid rgba(255,255,255,0.05)',
        // Extra room on the right: the fixed back-to-top button parks in that
        // corner and would otherwise sit on top of the Terms link.
        padding: mobile
          ? '20px 72px calc(20px + env(safe-area-inset-bottom)) 20px'
          : '22px 96px 22px 40px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 18,
        flexWrap: 'wrap',
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: 'rgba(255,255,255,0.25)',
          fontWeight: 400,
        }}
      >
        {mobile ? '© 2026 Operon.' : '© 2026 Operon. All rights reserved.'}
      </div>

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
    </footer>
  )
}
