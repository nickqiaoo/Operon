import { useEffect, useRef } from "react"
import { App as CapacitorApp } from "@capacitor/app"
import { nativePlatform } from "@/lib/native"

/**
 * Android hardware/gesture back.
 *
 * iOS has no equivalent, and without this the system default applies: back
 * closes the whole app. In an app whose main surface is a full-screen
 * conversation, that means one careless swipe throws the user out.
 *
 * Two tiers, because they need different ordering rules:
 *
 *   - Dismissible things (`useBackHandler`) form a LIFO stack, so back closes
 *     whatever was opened most recently.
 *   - The shell's own fallback (`useAndroidBackButton`) runs only when that
 *     stack is empty. It is deliberately NOT a stack entry: React runs child
 *     effects before parent ones, so a shell-level entry would register *above*
 *     the screens it contains and swallow their back presses.
 *
 * When nothing handles it, back exits the app — what Android users expect from
 * a home surface.
 */
type BackHandler = () => void

const stack: BackHandler[] = []

/**
 * Intercept back while `active`; popped automatically when it goes inactive or
 * the component unmounts.
 *
 * The handler lives in a ref so it can close over fresh state without
 * re-registering — re-registering would quietly promote it above things opened
 * after it.
 */
export function useBackHandler(active: boolean, handler: BackHandler): void {
  const ref = useRef(handler)
  ref.current = handler

  useEffect(() => {
    if (!active || nativePlatform() !== "android") return
    const entry: BackHandler = () => ref.current()
    stack.push(entry)
    return () => {
      const index = stack.lastIndexOf(entry)
      if (index !== -1) stack.splice(index, 1)
    }
  }, [active])
}

/**
 * Install the listener. Called once, by the shell.
 *
 * `onFallback` returns true if it consumed the press; returning false exits
 * the app. No-op off Android.
 */
export function useAndroidBackButton(onFallback?: () => boolean): void {
  const fallback = useRef(onFallback)
  fallback.current = onFallback

  useEffect(() => {
    if (nativePlatform() !== "android") return
    const handle = CapacitorApp.addListener("backButton", () => {
      // Peek, don't pop. The entry is removed by its own cleanup once the
      // handler actually closes something. Popping here would deregister a
      // handler that declined to act, and the *next* back press would then
      // exit the app out from under a still-open overlay.
      const top = stack[stack.length - 1]
      if (top) {
        top()
        return
      }
      if (fallback.current?.()) return
      void CapacitorApp.exitApp()
    })
    return () => {
      void handle.then((h) => h.remove()).catch(() => {})
    }
  }, [])
}
