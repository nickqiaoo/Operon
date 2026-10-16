import { Navbar } from './components/Navbar'
import { Footer } from './components/Footer'
import { BackToTop } from './components/BackToTop'
import { HeroSection } from './components/HeroSection'
import { AdaptersSection } from './components/AdaptersSection'
import { AssistantSection } from './components/AssistantSection'
import { ExternalAgentSection } from './components/ExternalAgentSection'
import { WorkflowSection } from './components/WorkflowSection'
import { TasksSection } from './components/TasksSection'
import { SddSection } from './components/SddSection'
import { PluginsSection } from './components/PluginsSection'
import { BrowserComputerSection } from './components/BrowserComputerSection'
import { MemoryChannelsSection } from './components/MemoryChannelsSection'
import { MobileSection } from './components/MobileSection'
import { FeaturesSection } from './components/FeaturesSection'
import { DownloadSection } from './components/DownloadSection'

/**
 * One continuous document, scrolled natively. Sections alternate between the
 * reading surface and the one-step-greyer sidebar tone (see `Section`), which
 * is what separates them — not glows or per-section colours.
 */
function App() {
  return (
    <>
      <Navbar />

      <main>
        <HeroSection />
        <AdaptersSection />
        <AssistantSection />
        <ExternalAgentSection />
        <WorkflowSection />
        <TasksSection />
        <SddSection />
        <PluginsSection />
        <BrowserComputerSection />
        <MemoryChannelsSection />
        <MobileSection />
        <FeaturesSection />
        <DownloadSection />
      </main>

      <Footer />
      <BackToTop />
    </>
  )
}

export default App
