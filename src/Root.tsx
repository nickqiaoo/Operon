import App from "./App"
import { MobileApp } from "./components/mobile/MobileApp"
import { RequestProgressBar } from "./components/RequestProgressBar"
import { useIsMobile } from "./hooks/useIsMobile"

/**
 * Top-level shell selector. The phone shell is intentionally gated to the
 * **web build on a phone-sized viewport** — the Electron desktop app always
 * gets the full multi-pane {@link App}, untouched. This keeps all mobile code
 * isolated behind one branch with zero risk to the desktop product.
 */
export default function Root() {
  const isMobile = useIsMobile()

  return (
    <>
      {/* Above both shells so it survives the full-screen pages App portals to
          body; self-hiding unless a request outlives its delay. */}
      <RequestProgressBar />
      {__APP_TARGET__ === "web" && isMobile ? <MobileApp /> : <App />}
    </>
  )
}
