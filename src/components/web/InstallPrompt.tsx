import { useEffect, useState } from 'react'
import { Share, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isNativeApp } from '@/lib/native'

/**
 * The `beforeinstallprompt` event (Chromium only). Not in lib.dom yet, so it's
 * typed locally.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'operon.pwa.installDismissed'

const isStandalone = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

const isIOS = (): boolean =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  // iPadOS reports as a Mac; disambiguate by touch support.
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/**
 * Dismissible "install to home screen" banner for the mobile web app.
 *
 *  - Chromium (Android): captures `beforeinstallprompt` and offers a one-tap
 *    Install button that triggers the native prompt.
 *  - iOS Safari: never fires that event and has no install API, so we show a
 *    short hint to use Share → Add to Home Screen instead.
 *
 * Hidden when already installed (standalone display mode) or previously
 * dismissed. Mounted only by {@link MobileApp}, i.e. web + phone-sized only.
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [iosHint, setIosHint] = useState(false)
  const [show, setShow] = useState(false)

  useEffect(() => {
    // Inside the packaged app there is nothing to install — but neither guard
    // below catches it: a Capacitor web view is not `display-mode: standalone`
    // and does not set `navigator.standalone`, while its user agent is a plain
    // iPhone Safari one, so `isIOS()` matches and the "Add to Home Screen" hint
    // was showing to people who had already installed from the App Store.
    if (isNativeApp()) return
    if (isStandalone() || localStorage.getItem(DISMISS_KEY)) return

    const onBeforeInstall = (e: Event) => {
      e.preventDefault() // stop Chrome's mini-infobar; we drive our own UI
      setDeferred(e as BeforeInstallPromptEvent)
      setShow(true)
    }
    const onInstalled = () => {
      setShow(false)
      localStorage.setItem(DISMISS_KEY, '1')
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)

    // iOS gives no install event — surface the manual hint instead.
    if (isIOS()) {
      setIosHint(true)
      setShow(true)
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (!show) return null

  const dismiss = () => {
    setShow(false)
    localStorage.setItem(DISMISS_KEY, '1')
  }

  const install = async () => {
    if (!deferred) return
    await deferred.prompt()
    await deferred.userChoice
    setShow(false)
    setDeferred(null)
  }

  return (
    <div
      className="fixed inset-x-3 z-[70] rounded-xl border border-border/50 bg-popover/95 p-3 shadow-float backdrop-blur"
      // Sit above the bottom tab bar (≈3.5rem + its safe-area inset).
      style={{ bottom: 'calc(env(safe-area-inset-bottom) + 4rem)' }}
    >
      <div className="flex items-center gap-3">
        <img src="/pwa-192x192.png" alt="" className="size-9 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Install Operon</p>
          {iosHint ? (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              Tap <Share className="inline size-3.5" /> then “Add to Home Screen”.
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Add it to your home screen for a full-screen app.
            </p>
          )}
        </div>
        {!iosHint && (
          <Button size="sm" className="h-8 shrink-0" onClick={() => void install()}>
            Install
          </Button>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
