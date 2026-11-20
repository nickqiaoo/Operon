import { useLayoutEffect, useRef } from "react"
import App from "./App"
import { MobileApp } from "./components/mobile/MobileApp"
import { useIsMobile } from "./hooks/useIsMobile"
import { useNativeStatusBar } from "./hooks/useNativeStatusBar"
import { useApplyCodeFont } from "./stores/code-font-store"
import { nativePlatform } from "./lib/native"

/**
 * Top-level shell selector. The phone shell is intentionally gated to the
 * **web build on a phone-sized viewport** — the Electron desktop app always
 * gets the full multi-pane {@link App}, untouched. This keeps all mobile code
 * isolated behind one branch with zero risk to the desktop product.
 */
export default function Root() {
  const isMobile = useIsMobile()
  useNativeStatusBar()
  useApplyCodeFont()
  const wasMobile = useRef(isMobile)
  const resumeWorkbench = nativePlatform() === "ios" && !wasMobile.current
  useLayoutEffect(() => {
    wasMobile.current = isMobile
  }, [isMobile])

  return (
    <>
      {__APP_TARGET__ === "web" && isMobile ? (
        <MobileApp resumeWorkbench={resumeWorkbench} />
      ) : (
        <App />
      )}
    </>
  )
}
