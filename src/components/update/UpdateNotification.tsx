import { useEffect, useRef } from "react"
import { toast } from "sonner"

import { useUpdateStore } from "@/stores/update-store"

type UpdateStatus =
  | { event: 'checking' }
  | { event: 'available'; version: string }
  | { event: 'not-available'; manual?: boolean; version?: string }
  | { event: 'progress'; percent: number }
  | { event: 'downloaded'; version: string }
  | { event: 'error'; message: string }

export function UpdateNotification() {
  const toastId = useRef<string | number | undefined>(undefined)

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onUpdateStatus) return
    return api.onUpdateStatus((status: UpdateStatus) => {
      switch (status.event) {
        case 'checking':
          break

        case 'not-available':
          if (status.manual) {
            toast.success(
              status.version
                ? `You're on the latest version (v${status.version})`
                : `You're on the latest version`,
              { duration: 3000 },
            )
          }
          break

        case 'available':
        case 'progress':
          break

        case 'downloaded':
          // No toast: the sidebar pill (UpdateReadyPill) owns this state so the
          // update waits quietly until the user asks about it.
          useUpdateStore.getState().setDownloadedVersion(status.version)
          break

        case 'error':
          toast.error('Failed to check for updates', {
            id: toastId.current,
            duration: 3000,
          })
          break
      }
    })
  }, [])

  return null
}
