import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { ZoomableImage } from './ImageZoom'
import { useIsMobile } from '../hooks/useIsMobile'
import screenshot1 from '../assets/screenshot1.png'
import screenshot2 from '../assets/screenshot2.png'

type HeroShotId = 'graphicalUi' | 'cli'

interface HeroShot {
  id: HeroShotId
  label: string
  src: string
  alt: string
  objectPosition: string
}

const HERO_SHOTS: HeroShot[] = [
  {
    id: 'graphicalUi',
    label: 'UI',
    src: screenshot1,
    alt: 'Operon graphical interface',
    objectPosition: 'center top',
  },
  {
    id: 'cli',
    label: 'CLI',
    src: screenshot2,
    alt: 'Operon CLI interface',
    objectPosition: 'center top',
  },
]

const SHOT_ROTATION_INTERVAL = 4200
const MANUAL_SELECTION_PAUSE = 9000
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeReducedMotion(onStoreChange: () => void) {
  const mql = window.matchMedia(REDUCED_MOTION_QUERY)
  mql.addEventListener('change', onStoreChange)
  return () => mql.removeEventListener('change', onStoreChange)
}

function getReducedMotionSnapshot() {
  if (typeof window === 'undefined') return false
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, getReducedMotionSnapshot, () => false)
}

/**
 * The hero used to be a two-state machine: `expanded` showed huge type with the
 * screenshot parked below the fold, and the first scroll gesture collapsed the
 * type and pulled the screenshot up — which meant the very first swipe on a
 * phone appeared to do nothing but shuffle the hero. It is one settled layout
 * now; scrolling just scrolls.
 *
 * Height is `100svh`, not `100dvh`. `dvh` tracks the collapsing address bar in
 * an in-app browser, so anything sized by it resizes mid-scroll. `svh` is the
 * small (address-bar-visible) height and stays put.
 */
export function HeroSection() {
  const mobile = useIsMobile()
  const prefersReducedMotion = usePrefersReducedMotion()
  const manualPauseUntil = useRef(0)
  const [activeShotId, setActiveShotId] = useState<HeroShotId>('graphicalUi')

  useEffect(() => {
    if (prefersReducedMotion || HERO_SHOTS.length < 2) return

    const interval = window.setInterval(() => {
      if (Date.now() < manualPauseUntil.current) return

      setActiveShotId((currentId) => {
        const currentIndex = HERO_SHOTS.findIndex((shot) => shot.id === currentId)
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % HERO_SHOTS.length
        return HERO_SHOTS[nextIndex].id
      })
    }, SHOT_ROTATION_INTERVAL)

    return () => window.clearInterval(interval)
  }, [prefersReducedMotion])

  const handleSelectShot = (id: HeroShotId) => {
    manualPauseUntil.current = Date.now() + MANUAL_SELECTION_PAUSE
    setActiveShotId(id)
  }

  return (
    <section
      style={{
        position: 'relative',
        minHeight: '100svh',
        width: '100%',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        // Phones fit the whole hero on one screen, so centre it. Desktop
        // cannot (the product shot would shrink to a thumbnail), so there the
        // wordmark block claims the fold and the shot breaks it deliberately.
        justifyContent: mobile ? 'center' : 'flex-start',
        paddingTop: mobile ? 52 : 64,
        paddingBottom: mobile ? 52 : 56,
        paddingInline: mobile ? 20 : 48,
      }}
    >
      {/* Local glow — the ambient layer lives in SiteBackground */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: '38%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: mobile ? 420 : 900,
          height: mobile ? 320 : 620,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(124,58,237,0.14) 0%, transparent 68%)',
          filter: 'blur(80px)',
          pointerEvents: 'none',
        }}
      />

      {/*
        Wordmark block. It takes roughly the upper third of the desktop hero,
        leaving enough room for the product shot to establish the UI before
        the next chapter enters. Mobile keeps the whole group vertically
        centred inside one stable viewport.
      */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          minHeight: mobile ? undefined : 'calc(37svh - 64px)',
          paddingBottom: mobile ? 34 : 30,
        }}
      >
        <OperonGlyph size={mobile ? 44 : 60} />

        <h1
          style={{
            fontFamily: "'General Sans', sans-serif",
            fontSize: mobile ? 'clamp(54px, 15vw, 88px)' : 'clamp(64px, 7.6vw, 118px)',
            fontWeight: 600,
            letterSpacing: '0.04em',
            lineHeight: 0.9,
            textTransform: 'uppercase',
            marginBottom: mobile ? 16 : 22,
          }}
        >
          <span className="bg-gradient-to-b from-white via-white to-white/40 bg-clip-text text-transparent">
            OPERON
          </span>
        </h1>

        <p
          style={{
            fontSize: mobile ? 15 : 'clamp(18px, 1.9vw, 24px)',
            color: 'rgba(255,255,255,0.42)',
            fontWeight: 300,
            letterSpacing: '0.02em',
          }}
        >
          One Interface. Every Agent.
        </p>
      </div>

      {/* Screenshot stage */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          maxWidth: mobile ? 440 : 980,
        }}
      >
        <div
          aria-hidden
          className="absolute -inset-6 rounded-3xl bg-indigo-500/10 blur-3xl"
          style={{ opacity: 0.55 }}
        />
        <div
          style={{
            position: 'relative',
            aspectRatio: '14 / 9',
            perspective: mobile ? 900 : 1600,
            transformStyle: 'preserve-3d',
          }}
        >
          {HERO_SHOTS.map((shot) => (
            <div key={shot.id} style={getDeckCardStyle({ isActive: activeShotId === shot.id, compact: mobile })}>
              <ZoomableImage
                src={shot.src}
                alt={shot.alt}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  objectPosition: shot.objectPosition,
                }}
              />
            </div>
          ))}
        </div>

        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: mobile ? 12 : 18,
            transform: 'translateX(-50%)',
            zIndex: 8,
          }}
        >
          <ShotSwitch activeShotId={activeShotId} onSelect={handleSelectShot} compact={mobile} />
        </div>
      </div>
    </section>
  )
}

function OperonGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
      style={{ margin: `0 auto ${size < 50 ? 20 : 28}px`, display: 'block' }}
    >
      <path fill="#6358DC" d="M312.607 320.213c7.186-11.909 22.72-15.771 34.696-8.626l120.42 71.849C475.34 387.981 480 396.167 480 405s-4.66 17.019-12.277 21.564l-120.42 71.849c-11.976 7.145-27.51 3.283-34.696-8.626s-3.301-27.357 8.674-34.502L405.559 405l-84.278-50.285c-11.975-7.145-15.859-22.593-8.674-34.502M714.859 631C728.744 631 740 642.193 740 656s-11.256 25-25.141 25H595.141C581.256 681 570 669.807 570 656s11.256-25 25.141-25z"/>
      <path fill="#6358DC" d="M836 512c0-178.94-145.06-324-324-324S188 333.06 188 512s145.06 324 324 324v96C280.04 932 92 743.96 92 512S280.04 92 512 92s420 188.04 420 420-188.04 420-420 420v-96c178.94 0 324-145.06 324-324"/>
      <path fill="#6358DC" d="M380.374 146c129.287 0 234.094 104.902 234.094 234.306 0 64.118-25.736 122.214-67.426 164.521-25.545 25.077-41.574 60.224-41.574 98.867 0 76.315 61.81 138.18 138.056 138.18 38.607 0 73.511-15.863 98.566-41.431l67.91 67.97C767.564 851.376 708.652 878 643.524 878 514.237 878 409.43 773.098 409.43 643.694c0-65.187 26.778-124.365 69.702-166.839 24.311-24.909 39.298-58.976 39.298-96.549 0-76.315-61.81-138.18-138.056-138.18-37.538 0-71.576 14.998-96.462 39.331L216 213.484C258.268 171.756 316.315 146 380.374 146"/>
    </svg>
  )
}

function getDeckCardStyle({ isActive, compact }: { isActive: boolean; compact: boolean }): CSSProperties {
  const restingTransform = compact
    ? 'translate3d(24px, 14px, -40px) rotateY(-7deg) rotateZ(2deg) scale(0.95)'
    : 'translate3d(80px, 30px, -100px) rotateX(1.5deg) rotateY(-8deg) rotateZ(2.4deg) scale(0.965)'

  return {
    position: 'absolute',
    inset: 0,
    zIndex: isActive ? 3 : 2,
    overflow: 'hidden',
    borderRadius: compact ? 12 : 16,
    border: isActive ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(8,8,14,0.94)',
    boxShadow: isActive
      ? compact
        ? '0 24px 60px rgba(0,0,0,0.45)'
        : '0 48px 120px rgba(0,0,0,0.5)'
      : compact
        ? '0 16px 42px rgba(0,0,0,0.36)'
        : '0 30px 80px rgba(0,0,0,0.36)',
    opacity: isActive ? 1 : 0.6,
    filter: isActive ? 'none' : 'saturate(0.86) brightness(0.78)',
    transform: isActive ? 'translate3d(0, 0, 0) scale(1)' : restingTransform,
    transformOrigin: isActive ? 'center center' : '72% 54%',
    transformStyle: 'preserve-3d',
    pointerEvents: isActive ? 'auto' : 'none',
    transition:
      'transform 0.78s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.45s ease-out, filter 0.45s ease-out, box-shadow 0.78s cubic-bezier(0.16, 1, 0.3, 1)',
  }
}

function ShotSwitch({
  activeShotId,
  onSelect,
  compact = false,
}: {
  activeShotId: HeroShotId
  onSelect: (id: HeroShotId) => void
  compact?: boolean
}) {
  return (
    <div
      role="tablist"
      aria-label="Hero screenshot view"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: 4,
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.12)',
        background: 'rgba(12,12,18,0.72)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        boxShadow: '0 18px 50px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.08)',
      }}
    >
      {HERO_SHOTS.map((shot) => {
        const isActive = activeShotId === shot.id
        return (
          <button
            key={shot.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={(event) => {
              event.stopPropagation()
              onSelect(shot.id)
            }}
            style={{
              height: compact ? 28 : 32,
              minWidth: compact ? 84 : 78,
              border: 0,
              borderRadius: 999,
              padding: compact ? '0 14px' : '0 16px',
              background: isActive ? 'rgba(255,255,255,0.92)' : 'transparent',
              color: isActive ? 'rgba(8,8,12,0.92)' : 'rgba(255,255,255,0.58)',
              fontSize: compact ? 12 : 13,
              fontWeight: 600,
              lineHeight: 1,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              transition: 'background 0.22s ease, color 0.22s ease',
            }}
          >
            {shot.label}
          </button>
        )
      })}
    </div>
  )
}
