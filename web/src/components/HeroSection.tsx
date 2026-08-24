import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { ZoomableImage } from './ImageZoom'
import { useIsMobile } from '../hooks/useIsMobile'
import { useIsCompactViewport } from '../hooks/useIsCompactViewport'
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
 * Desktop: expanded = true means text is huge and the screenshot stage sits below the fold.
 *          expanded = false means text fades and the stage moves into the hero.
 * Mobile: static layout with logo/text above the screenshot stage.
 */
export function HeroSection({ expanded }: { expanded: boolean }) {
  const mobile = useIsMobile()
  const compactViewport = useIsCompactViewport()
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

  if (mobile) {
    return (
      <div className="relative h-full w-full overflow-hidden flex flex-col items-center justify-center">
        {/* Background gradient glow */}
        <div className="absolute inset-0 pointer-events-none" style={{ opacity: 0.25 }}>
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[300px] rounded-full bg-indigo-600/30 blur-[100px]" />
          <div className="absolute top-1/3 left-1/3 w-[200px] h-[200px] rounded-full bg-purple-600/20 blur-[80px]" />
        </div>

        {/* Grid */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
                              linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)`,
            backgroundSize: '40px 40px',
          }}
        />

        {/* Logo + text: main visual, vertically centered */}
        <div className="relative z-10 flex flex-col items-center text-center px-6">
          <svg
            width="48"
            height="48"
            viewBox="0 0 1024 1024"
            xmlns="http://www.w3.org/2000/svg"
            style={{ marginBottom: 20 }}
          >
            <path fill="#6358DC" d="M312.607 320.213c7.186-11.909 22.72-15.771 34.696-8.626l120.42 71.849C475.34 387.981 480 396.167 480 405s-4.66 17.019-12.277 21.564l-120.42 71.849c-11.976 7.145-27.51 3.283-34.696-8.626s-3.301-27.357 8.674-34.502L405.559 405l-84.278-50.285c-11.975-7.145-15.859-22.593-8.674-34.502M714.859 631C728.744 631 740 642.193 740 656s-11.256 25-25.141 25H595.141C581.256 681 570 669.807 570 656s11.256-25 25.141-25z"/>
            <path fill="#6358DC" d="M836 512c0-178.94-145.06-324-324-324S188 333.06 188 512s145.06 324 324 324v96C280.04 932 92 743.96 92 512S280.04 92 512 92s420 188.04 420 420-188.04 420-420 420v-96c178.94 0 324-145.06 324-324"/>
            <path fill="#6358DC" d="M380.374 146c129.287 0 234.094 104.902 234.094 234.306 0 64.118-25.736 122.214-67.426 164.521-25.545 25.077-41.574 60.224-41.574 98.867 0 76.315 61.81 138.18 138.056 138.18 38.607 0 73.511-15.863 98.566-41.431l67.91 67.97C767.564 851.376 708.652 878 643.524 878 514.237 878 409.43 773.098 409.43 643.694c0-65.187 26.778-124.365 69.702-166.839 24.311-24.909 39.298-58.976 39.298-96.549 0-76.315-61.81-138.18-138.056-138.18-37.538 0-71.576 14.998-96.462 39.331L216 213.484C258.268 171.756 316.315 146 380.374 146"/>
          </svg>

          <h1
            style={{
              fontFamily: "'General Sans', sans-serif",
              fontSize: 'clamp(64px, 18vw, 100px)',
              fontWeight: 600,
              letterSpacing: '0.04em',
              lineHeight: 0.9,
              textTransform: 'uppercase',
              marginBottom: 14,
            }}
          >
            <span className="bg-gradient-to-b from-white via-white to-white/40 bg-clip-text text-transparent">
              OPERON
            </span>
          </h1>

          <p
            style={{
              fontSize: 16,
              color: 'rgba(255,255,255,0.4)',
              fontWeight: 300,
              letterSpacing: '0.02em',
              marginBottom: 36,
            }}
          >
            One Interface. Every Agent.
          </p>

          {/* Screenshot stage below text */}
          <div
            style={{
              width: '100%',
              maxWidth: 360,
              position: 'relative',
              height: 190,
              perspective: 900,
              transformStyle: 'preserve-3d',
            }}
          >
            <div
              className="absolute -inset-6 rounded-2xl bg-indigo-500/10 blur-2xl"
              style={{ opacity: 0.5 }}
            />
            {HERO_SHOTS.map((shot) => {
              const isActive = activeShotId === shot.id
              return (
                <div
                  key={shot.id}
                  style={getDeckCardStyle({
                    isActive,
                    compact: true,
                  })}
                >
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
              )
            })}
            <ShotSwitch
              activeShotId={activeShotId}
              onSelect={handleSelectShot}
              compact
            />
          </div>
        </div>

        {/* Scroll indicator */}
        <div
          className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
          style={{ pointerEvents: 'none', zIndex: 20 }}
        >
          <span className="text-[9px] text-white/20 uppercase tracking-[0.2em] font-medium">Scroll</span>
          <div className="w-4 h-6 rounded-full border border-white/10 flex items-start justify-center p-0.5">
            <div className="w-0.5 h-1.5 rounded-full bg-white/30 animate-bounce" />
          </div>
        </div>
      </div>
    )
  }

  // Desktop version with expand/collapse animation
  return (
    <div className="relative h-full w-full overflow-hidden flex flex-col items-center justify-center">
      {/* Background gradient glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ opacity: expanded ? 0.2 : 0.3, transition: 'opacity 1s' }}
      >
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] rounded-full bg-indigo-600/30 blur-[150px]" />
        <div className="absolute top-1/3 left-1/3 w-[400px] h-[400px] rounded-full bg-purple-600/20 blur-[120px]" />
        <div className="absolute top-1/2 right-1/4 w-[300px] h-[300px] rounded-full bg-blue-600/15 blur-[100px]" />
      </div>

      {/* Grid */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)`,
          backgroundSize: '60px 60px',
        }}
      />

      {/* Floating particles */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="absolute w-1 h-1 rounded-full bg-indigo-400/30"
            style={{
              left: `${15 + i * 15}%`,
              top: `${20 + (i % 3) * 25}%`,
              animation: `hero-float ${3 + i * 0.5}s ease-in-out infinite alternate`,
              animationDelay: `${i * 0.3}s`,
            }}
          />
        ))}
      </div>

      {/* Text: huge when expanded, smaller when collapsed */}
      <div
        className="relative z-10 text-center px-6"
        style={{
          transform: expanded
            ? 'translateY(-20px) scale(1)'
            : 'translateY(-60px) scale(0.7)',
          opacity: expanded ? 1 : 0,
          transition: 'transform 1s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.65s ease-out',
          pointerEvents: expanded ? 'auto' : 'none',
        }}
      >
        {/* Logo icon */}
        <svg
          width={compactViewport ? 56 : 64}
          height={compactViewport ? 56 : 64}
          viewBox="0 0 1024 1024"
          xmlns="http://www.w3.org/2000/svg"
          style={{ margin: '0 auto 28px', display: 'block' }}
        >
          <path fill="#6358DC" d="M312.607 320.213c7.186-11.909 22.72-15.771 34.696-8.626l120.42 71.849C475.34 387.981 480 396.167 480 405s-4.66 17.019-12.277 21.564l-120.42 71.849c-11.976 7.145-27.51 3.283-34.696-8.626s-3.301-27.357 8.674-34.502L405.559 405l-84.278-50.285c-11.975-7.145-15.859-22.593-8.674-34.502M714.859 631C728.744 631 740 642.193 740 656s-11.256 25-25.141 25H595.141C581.256 681 570 669.807 570 656s11.256-25 25.141-25z"/>
          <path fill="#6358DC" d="M836 512c0-178.94-145.06-324-324-324S188 333.06 188 512s145.06 324 324 324v96C280.04 932 92 743.96 92 512S280.04 92 512 92s420 188.04 420 420-188.04 420-420 420v-96c178.94 0 324-145.06 324-324"/>
          <path fill="#6358DC" d="M380.374 146c129.287 0 234.094 104.902 234.094 234.306 0 64.118-25.736 122.214-67.426 164.521-25.545 25.077-41.574 60.224-41.574 98.867 0 76.315 61.81 138.18 138.056 138.18 38.607 0 73.511-15.863 98.566-41.431l67.91 67.97C767.564 851.376 708.652 878 643.524 878 514.237 878 409.43 773.098 409.43 643.694c0-65.187 26.778-124.365 69.702-166.839 24.311-24.909 39.298-58.976 39.298-96.549 0-76.315-61.81-138.18-138.056-138.18-37.538 0-71.576 14.998-96.462 39.331L216 213.484C258.268 171.756 316.315 146 380.374 146"/>
        </svg>

        <h1
          style={{
            fontFamily: "'General Sans', sans-serif",
            fontSize: compactViewport ? 'clamp(72px, 12vw, 128px)' : 'clamp(80px, 15vw, 180px)',
            fontWeight: 600,
            letterSpacing: '0.04em',
            lineHeight: 0.9,
            textTransform: 'uppercase',
            marginBottom: 20,
          }}
        >
          <span className="bg-gradient-to-b from-white via-white to-white/40 bg-clip-text text-transparent">
            OPERON
          </span>
        </h1>

        <p
          style={{
            fontSize: 'clamp(18px, 2.5vw, 28px)',
            color: 'rgba(255,255,255,0.4)',
            fontWeight: 300,
            letterSpacing: '0.02em',
          }}
        >
          One Interface. Every Agent.
        </p>
      </div>

      {/* Screenshot stage: one large surface with switchable views */}
      <div
        className="absolute z-10"
        style={{
          left: '50%',
          top: '50%',
          width: expanded ? (compactViewport ? '74vw' : '82vw') : compactViewport ? '76vw' : '86vw',
          maxWidth: expanded ? (compactViewport ? 960 : 1120) : compactViewport ? 1040 : 1320,
          transform: expanded
            ? compactViewport
              ? 'translate(-50%, 44%) scale(0.92)'
              : 'translate(-50%, 40%) scale(0.98)'
            : compactViewport
              ? 'translate(-50%, -48%) scale(0.94)'
              : 'translate(-50%, -50%) scale(1)',
          transition:
            'transform 1.2s cubic-bezier(0.16, 1, 0.3, 1), width 1.2s cubic-bezier(0.16, 1, 0.3, 1), max-width 1.2s cubic-bezier(0.16, 1, 0.3, 1)',
          willChange: 'transform',
        }}
      >
        {/* Glow behind screenshots */}
        <div
          className="absolute -inset-10 rounded-3xl bg-indigo-500/10 blur-3xl"
          style={{
            opacity: expanded ? 0.4 : 0.6,
            transition: 'opacity 1s',
          }}
        />
        <div
          style={{
            position: 'relative',
            aspectRatio: '14 / 9',
            perspective: 1600,
            transformStyle: 'preserve-3d',
          }}
        >
          {HERO_SHOTS.map((shot) => {
            const isActive = activeShotId === shot.id
            return (
              <div
                key={shot.id}
                style={getDeckCardStyle({
                  isActive,
                  expanded,
                })}
              >
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
            )
          })}
        </div>
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: expanded ? -56 : 18,
            transform: 'translateX(-50%)',
            opacity: expanded ? 0 : 1,
            transition: 'opacity 0.45s ease-out, bottom 1s cubic-bezier(0.16, 1, 0.3, 1)',
            pointerEvents: expanded ? 'none' : 'auto',
          }}
        >
          <ShotSwitch
            activeShotId={activeShotId}
            onSelect={handleSelectShot}
          />
        </div>
      </div>

      {/* Scroll indicator: only when expanded */}
      <div
        className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3"
        style={{
          opacity: expanded ? 1 : 0,
          transition: 'opacity 0.5s',
          pointerEvents: 'none',
        }}
      >
        <span className="text-[10px] text-white/20 uppercase tracking-[0.2em] font-medium">Scroll</span>
        <div className="w-5 h-8 rounded-full border border-white/10 flex items-start justify-center p-1">
          <div className="w-1 h-2 rounded-full bg-white/30 animate-bounce" />
        </div>
      </div>

      <style>{`
        @keyframes hero-float {
          from { transform: translateY(0) translateX(0); opacity: 0.3; }
          to { transform: translateY(-20px) translateX(10px); opacity: 0.6; }
        }
      `}</style>
    </div>
  )
}

function getDeckCardStyle({
  isActive,
  compact = false,
  expanded = false,
}: {
  isActive: boolean
  compact?: boolean
  expanded?: boolean
}): CSSProperties {
  const restingTransform = compact
    ? 'translate3d(28px, 16px, -44px) rotateY(-7deg) rotateZ(2.2deg) scale(0.95)'
    : 'translate3d(86px, 32px, -100px) rotateX(1.5deg) rotateY(-8deg) rotateZ(2.4deg) scale(0.965)'

  return {
    position: 'absolute',
    inset: 0,
    zIndex: isActive ? 3 : 2,
    overflow: 'hidden',
    borderRadius: compact ? 12 : expanded ? 16 : 14,
    border: isActive ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(8,8,14,0.94)',
    boxShadow: isActive
      ? compact
        ? '0 24px 60px rgba(0,0,0,0.45)'
        : '0 48px 120px rgba(0,0,0,0.5)'
      : compact
        ? '0 16px 42px rgba(0,0,0,0.36)'
        : '0 30px 80px rgba(0,0,0,0.36)',
    opacity: isActive ? 1 : expanded ? 0.44 : 0.72,
    filter: isActive ? 'none' : 'saturate(0.86) brightness(0.78)',
    transform: isActive
      ? 'translate3d(0, 0, 0) rotateX(0deg) rotateY(0deg) rotateZ(0deg) scale(1)'
      : restingTransform,
    transformOrigin: isActive ? 'center center' : '72% 54%',
    transformStyle: 'preserve-3d',
    pointerEvents: isActive ? 'auto' : 'none',
    willChange: 'transform, opacity, filter',
    transition:
      'transform 0.78s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.45s ease-out, filter 0.45s ease-out, box-shadow 0.78s cubic-bezier(0.16, 1, 0.3, 1), border-radius 1.2s cubic-bezier(0.16, 1, 0.3, 1)',
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
        position: compact ? 'absolute' : 'relative',
        left: compact ? '50%' : undefined,
        bottom: compact ? 10 : undefined,
        transform: compact ? 'translateX(-50%)' : undefined,
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
        zIndex: 8,
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
              height: compact ? 26 : 32,
              minWidth: compact ? 92 : 78,
              border: 0,
              borderRadius: 999,
              padding: compact ? '0 12px' : '0 16px',
              background: isActive ? 'rgba(255,255,255,0.92)' : 'transparent',
              color: isActive ? 'rgba(8,8,12,0.92)' : 'rgba(255,255,255,0.58)',
              fontSize: compact ? 11 : 13,
              fontWeight: 600,
              lineHeight: 1,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              transition: 'background 0.22s ease, color 0.22s ease, transform 0.22s ease',
            }}
          >
            {shot.label}
          </button>
        )
      })}
    </div>
  )
}
