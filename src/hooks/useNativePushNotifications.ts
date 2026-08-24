import { useEffect, useRef } from "react"
import { PushNotifications } from "@capacitor/push-notifications"
import { Capacitor } from "@capacitor/core"
import { isNativeApp } from "@/lib/native"
import { rememberPushDeviceToken } from "@/lib/push-device"
import { isAuthed } from "@/lib/web-auth"

const BROKER = (import.meta.env.VITE_BROKER_URL ?? "").replace(/\/$/, "")

/** Where a tapped notification wants to land. */
export interface PushTarget {
  chatId?: number
  taskId?: number
  projectId?: number
  workspaceId?: number
  title?: string
}

/**
 * Register this device for APNs and route taps back into the app.
 *
 * The inbox already persists notifications server-side and echoes them over
 * SSE, but SSE only reaches a client that is currently connected — which a
 * backgrounded phone is not. This is the second delivery path for the same
 * events: the desktop node posts them to the broker, the broker sends them to
 * the device tokens registered here (see broker/apns.go).
 *
 * No-op outside the packaged app. Everything is best-effort: a user who
 * declines the permission prompt keeps a fully working app.
 */
export function useNativePushNotifications(onOpen: (target: PushTarget) => void): void {
  // The listener is installed once, but must always call the newest handler —
  // `onOpen` closes over React state that changes as the app runs.
  const handler = useRef(onOpen)
  handler.current = onOpen

  useEffect(() => {
    if (!isNativeApp() || !BROKER) return
    let cancelled = false
    const removers: Array<() => void> = []

    const register = async () => {
      let permission = await PushNotifications.checkPermissions()
      if (permission.receive === "prompt" || permission.receive === "prompt-with-rationale") {
        permission = await PushNotifications.requestPermissions()
      }
      if (permission.receive !== "granted" || cancelled) return

      const registration = await PushNotifications.addListener("registration", (token) => {
        // Kept so sign-out can hand the token back (see unregisterPushDevice).
        rememberPushDeviceToken(token.value)
        // Fire-and-forget: the fetch interceptor attaches the bearer token, and
        // a failure here only costs push until the next launch.
        void fetch(`${BROKER}/auth/push/devices`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // The broker dispatches to APNs or FCM off this value, so it must be
          // the real platform rather than a constant.
          body: JSON.stringify({ token: token.value, platform: Capacitor.getPlatform() }),
        }).catch(() => {})
      })
      removers.push(() => void registration.remove())

      const failure = await PushNotifications.addListener("registrationError", (err) => {
        console.error("[push] APNs registration failed:", err)
      })
      removers.push(() => void failure.remove())

      const tapped = await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
        handler.current(targetFromPayload(action.notification.data))
      })
      removers.push(() => void tapped.remove())

      await PushNotifications.register()
    }

    // Registering before sign-in would bind the device to nobody: the broker
    // stores the token against the authenticated user.
    if (isAuthed()) void register().catch((err) => console.error("[push] setup failed:", err))

    return () => {
      cancelled = true
      for (const remove of removers) remove()
    }
  }, [])
}

/**
 * APNs delivers custom payload values as strings on some paths and numbers on
 * others, so every id is normalized here rather than at three call sites.
 */
function targetFromPayload(data: unknown): PushTarget {
  const record = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>
  const num = (value: unknown): number | undefined => {
    const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return {
    chatId: num(record.chatId),
    taskId: num(record.taskId),
    projectId: num(record.projectId),
    workspaceId: num(record.workspaceId),
    title: typeof record.title === "string" ? record.title : undefined,
  }
}
