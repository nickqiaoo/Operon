import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useIsMobile } from './hooks/useIsMobile'
import { useIsCompactViewport } from './hooks/useIsCompactViewport'
import { Navbar } from './components/Navbar'
import { Footer } from './components/Footer'
import { HeroSection } from './components/HeroSection'
import { AdaptersSection } from './components/AdaptersSection'
import { WorkflowSection } from './components/WorkflowSection'
import { ExternalAgentSection } from './components/ExternalAgentSection'
import { ChannelsSection } from './components/ChannelsSection'
import { TasksSection } from './components/TasksSection'
import { SddSection } from './components/SddSection'
import { MemorySection } from './components/MemorySection'
import { BrowserComputerSection } from './components/BrowserComputerSection'
import { MobileSection } from './components/MobileSection'
import { FeaturesSection } from './components/FeaturesSection'
import { ComingSoonSection } from './components/ComingSoonSection'

/**
 * One entry per full-screen page, in order. `TOTAL_PAGES` is derived from this
 * list, and both the paging bounds and the indicator dots read it — so deleting
 * a section here can't leave the page count stale and let the app scroll into a
 * blank page that no longer exists.
 */
const PAGES: { key: string; render: (props: { heroExpanded: boolean }) => ReactNode }[] = [
  { key: 'hero', render: ({ heroExpanded }) => <HeroSection expanded={heroExpanded} /> },
  { key: 'adapters', render: () => <AdaptersSection /> },
  { key: 'external-agent', render: () => <ExternalAgentSection /> },
  { key: 'workflow', render: () => <WorkflowSection /> },
  { key: 'channels', render: () => <ChannelsSection /> },
  { key: 'tasks', render: () => <TasksSection /> },
  { key: 'sdd', render: () => <SddSection /> },
  { key: 'memory', render: () => <MemorySection /> },
  { key: 'browser-computer', render: () => <BrowserComputerSection /> },
  { key: 'mobile', render: () => <MobileSection /> },
  { key: 'features', render: () => <FeaturesSection /> },
  { key: 'coming-soon', render: () => <ComingSoonSection /> },
]

const TOTAL_PAGES = PAGES.length

function App() {
  const mobile = useIsMobile()
  const compactViewport = useIsCompactViewport()
  const pageCanScrollInternally = mobile || compactViewport

  // Lock body scroll for fullpage mode
  useLayoutEffect(() => {
    document.documentElement.classList.add('no-scroll')
    return () => document.documentElement.classList.remove('no-scroll')
  }, [])

  const [currentPage, setCurrentPage] = useState(0)
  const [heroExpanded, setHeroExpanded] = useState(true)
  const isAnimating = useRef(false)
  const touchStartY = useRef(0)
  const pagesContainerRef = useRef<HTMLDivElement>(null)

  // On mobile and short laptop viewports, wait for the current page's
  // internal scroll area to reach its boundary before paging.
  const canPageScroll = useCallback(
    (direction: 'down' | 'up') => {
      if (!pageCanScrollInternally || !pagesContainerRef.current) return true
      const pageEl = pagesContainerRef.current.children[currentPage] as HTMLElement
      if (!pageEl) return true
      // Find scrollable child (the section's inner container with overflow: auto)
      const scrollable = pageEl.querySelector<HTMLElement>('[data-scrollable]')
      if (!scrollable) return true
      const { scrollTop, scrollHeight, clientHeight } = scrollable
      const threshold = 5
      if (direction === 'down') {
        return scrollTop + clientHeight >= scrollHeight - threshold
      }
      return scrollTop <= threshold
    },
    [pageCanScrollInternally, currentPage]
  )

  const goToPage = useCallback(
    (page: number) => {
      const clamped = Math.max(0, Math.min(page, TOTAL_PAGES - 1))
      if (clamped === currentPage) return
      isAnimating.current = true
      setCurrentPage(clamped)
      // When leaving hero forward, ensure it's collapsed
      if (currentPage === 0 && clamped > 0) {
        setHeroExpanded(false)
      }
      setTimeout(() => {
        isAnimating.current = false
      }, 800)
    },
    [currentPage]
  )

  const handleScrollDown = useCallback(() => {
    if (isAnimating.current) return
    if (!canPageScroll('down')) return
    // Special: on hero page, first collapse, then go to next page
    // On mobile, skip collapse step and go directly to next page
    if (currentPage === 0 && heroExpanded) {
      if (mobile) {
        setHeroExpanded(false)
        goToPage(1)
      } else {
        isAnimating.current = true
        setHeroExpanded(false)
        setTimeout(() => {
          isAnimating.current = false
        }, 1000)
      }
      return
    }
    goToPage(currentPage + 1)
  }, [currentPage, heroExpanded, goToPage, canPageScroll, mobile])

  const handleScrollUp = useCallback(() => {
    if (isAnimating.current) return
    if (!canPageScroll('up')) return
    // Special: on hero page but collapsed, expand first
    if (currentPage === 0 && !heroExpanded) {
      isAnimating.current = true
      setHeroExpanded(true)
      setTimeout(() => {
        isAnimating.current = false
      }, 1000)
      return
    }
    // Coming back to hero from page 1
    if (currentPage === 1) {
      // On mobile, go back to hero expanded directly
      if (mobile) {
        setHeroExpanded(true)
      } else {
        setHeroExpanded(false)
      }
    }
    goToPage(currentPage - 1)
  }, [currentPage, heroExpanded, goToPage, canPageScroll, mobile])

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (isAnimating.current) return
      if (Math.abs(e.deltaY) < 30) return
      const direction = e.deltaY > 0 ? 'down' : 'up'
      if (pageCanScrollInternally && !canPageScroll(direction)) return

      e.preventDefault()
      if (e.deltaY > 0) {
        handleScrollDown()
      } else {
        handleScrollUp()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isAnimating.current) return
      if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        handleScrollDown()
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault()
        handleScrollUp()
      }
    }

    const handleTouchStart = (e: TouchEvent) => {
      touchStartY.current = e.touches[0].clientY
    }

    const handleTouchEnd = (e: TouchEvent) => {
      if (isAnimating.current) return
      const delta = touchStartY.current - e.changedTouches[0].clientY
      if (Math.abs(delta) < 50) return
      if (delta > 0) {
        handleScrollDown()
      } else {
        handleScrollUp()
      }
    }

    window.addEventListener('wheel', handleWheel, { passive: false })
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('touchstart', handleTouchStart, { passive: true })
    window.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      window.removeEventListener('wheel', handleWheel)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('touchstart', handleTouchStart)
      window.removeEventListener('touchend', handleTouchEnd)
    }
  }, [canPageScroll, handleScrollDown, handleScrollUp, pageCanScrollInternally])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        overflow: 'hidden',
      }}
    >
      {/* Sliding container */}
      <div
        ref={pagesContainerRef}
        style={{
          transform: `translateY(calc(-${currentPage} * 100dvh))`,
          transition: 'transform 0.8s cubic-bezier(0.76, 0, 0.24, 1)',
          willChange: 'transform',
        }}
      >
        {PAGES.map((page) => (
          <div key={page.key} style={{ height: '100dvh', width: '100vw' }}>
            {page.render({ heroExpanded })}
          </div>
        ))}
      </div>

      <Navbar />
      {!mobile && <Footer />}

      {/* Page indicator dots */}
      <div
        style={{
          position: 'fixed',
          right: mobile ? 10 : 24,
          top: '50%',
          transform: 'translateY(-50%)',
          display: mobile ? 'none' : 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          zIndex: 50,
        }}
      >
        {Array.from({ length: TOTAL_PAGES }, (_, i) => (
          <div
            key={i}
            onClick={() => {
              if (i === 0) setHeroExpanded(false)
              goToPage(i)
            }}
            style={{
              width: i === currentPage ? 6 : 4,
              height: i === currentPage ? 6 : 4,
              borderRadius: '50%',
              backgroundColor: i === currentPage ? '#fff' : 'rgba(255,255,255,0.15)',
              cursor: 'pointer',
              transition: 'all 0.4s',
            }}
          />
        ))}
      </div>
    </div>
  )
}

export default App
