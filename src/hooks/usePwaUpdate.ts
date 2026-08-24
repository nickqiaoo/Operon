import { useCallback, useEffect, useRef, useState } from "react"
import { registerSW } from "virtual:pwa-register"

export interface PwaUpdateState {
  updateAvailable: boolean
  refresh: () => void
  dismiss: () => void
}

export function usePwaUpdate(): PwaUpdateState {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const updateRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null)
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
  const lastUpdateCheckRef = useRef(0)

  const checkForUpdate = useCallback(() => {
    if (__APP_TARGET__ !== "web") return
    if (typeof window === "undefined") return
    if (!("serviceWorker" in navigator)) return
    if (document.visibilityState !== "visible") return

    const now = Date.now()
    if (now - lastUpdateCheckRef.current < 3000) return
    lastUpdateCheckRef.current = now

    const updateRegistration = (registration: ServiceWorkerRegistration | null | undefined) => {
      if (!registration) return
      void registration.update().catch((error: unknown) => {
        console.warn("[pwa] foreground update check failed", error)
      })
    }

    if (registrationRef.current) {
      updateRegistration(registrationRef.current)
      return
    }

    void navigator.serviceWorker.getRegistration().then(updateRegistration).catch((error: unknown) => {
      console.warn("[pwa] service worker lookup failed", error)
    })
  }, [])

  useEffect(() => {
    if (__APP_TARGET__ !== "web") return

    updateRef.current = registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, registration) {
        registrationRef.current = registration ?? null
        checkForUpdate()
      },
      onNeedRefresh() {
        setUpdateAvailable(true)
      },
      onRegisterError(error) {
        console.warn("[pwa] service worker registration failed", error)
      },
    })

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") checkForUpdate()
    }

    document.addEventListener("visibilitychange", onVisibilityChange)
    window.addEventListener("focus", checkForUpdate)
    window.addEventListener("pageshow", checkForUpdate)

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.removeEventListener("focus", checkForUpdate)
      window.removeEventListener("pageshow", checkForUpdate)
    }
  }, [checkForUpdate])

  const refresh = useCallback(() => {
    void updateRef.current?.(true)
  }, [])

  const dismiss = useCallback(() => {
    setUpdateAvailable(false)
  }, [])

  return { updateAvailable, refresh, dismiss }
}
