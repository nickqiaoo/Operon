/**
 * One fixed backdrop for the whole page.
 *
 * Each section used to paint its own pair of 800–900px colour blurs. That was
 * invisible when only one section was ever on screen, but on a continuous
 * scroll they run together into a rainbow band. The ambient layer lives here
 * now, stays put while the page scrolls, and sections only add a faint
 * one-sided tint of their own (see SectionShell).
 */
export function SiteBackground() {
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: -1,
        pointerEvents: 'none',
        background: '#000',
      }}
    >
      {/* Ambient glow, anchored to the top of the viewport */}
      <div
        style={{
          position: 'absolute',
          top: '-30%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(1400px, 160vw)',
          height: 'min(1000px, 110vh)',
          borderRadius: '50%',
          background:
            'radial-gradient(circle, rgba(99,102,241,0.16) 0%, rgba(99,102,241,0.05) 45%, transparent 70%)',
          filter: 'blur(60px)',
        }}
      />

      {/* Grid */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)`,
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(ellipse 120% 80% at 50% 0%, #000 30%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse 120% 80% at 50% 0%, #000 30%, transparent 75%)',
        }}
      />
    </div>
  )
}
