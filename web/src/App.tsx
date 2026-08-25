import { Navbar } from './components/Navbar'
import { Footer } from './components/Footer'
import { SiteBackground } from './components/SiteBackground'
import { BackToTop } from './components/BackToTop'
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
 * One continuous document, scrolled natively.
 *
 * This page used to be a hand-rolled fullpage deck: body scroll locked, twelve
 * viewport-sized panes translated by `translateY(-n * 100dvh)`, and wheel /
 * key / touch events intercepted to step between them. That cost us the two
 * things a landing page most needs on a phone — it took one deliberate gesture
 * per section to get anywhere, and touch only committed on `touchend`, so
 * nothing tracked the finger. In an in-app browser (opening the link from
 * Twitter, say) it also fought the chrome: `100dvh` changes as the address bar
 * collapses, which shifted the translated container mid-gesture.
 *
 * Native scrolling gives all of that back for free — momentum, overscroll,
 * find-in-page, tap-status-bar-to-top, and a working scroll position on
 * restore. Sections keep their identity through spacing, a faint chapter tint
 * and a scroll-in reveal rather than through owning a whole viewport.
 */
function App() {
  return (
    <>
      <SiteBackground />
      <Navbar />

      <main>
        <HeroSection />
        <AdaptersSection />
        <ExternalAgentSection />
        <WorkflowSection />
        <ChannelsSection />
        <TasksSection />
        <SddSection />
        <MemorySection />
        <BrowserComputerSection />
        <MobileSection />
        <FeaturesSection />
        <ComingSoonSection />
      </main>

      <Footer />
      <BackToTop />
    </>
  )
}

export default App
