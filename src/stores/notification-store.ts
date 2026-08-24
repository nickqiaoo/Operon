import { create } from "zustand"
import { persist } from "zustand/middleware"

interface NotificationStore {
  enabled: boolean
  notifyOnComplete: boolean
  notifyOnApproval: boolean
  setEnabled: (enabled: boolean) => void
  setNotifyOnComplete: (enabled: boolean) => void
  setNotifyOnApproval: (enabled: boolean) => void
}

export const useNotificationStore = create<NotificationStore>()(
  persist(
    (set) => ({
      enabled: true,
      notifyOnComplete: true,
      notifyOnApproval: true,
      setEnabled: (enabled) => set({ enabled }),
      setNotifyOnComplete: (notifyOnComplete) => set({ notifyOnComplete }),
      setNotifyOnApproval: (notifyOnApproval) => set({ notifyOnApproval }),
    }),
    {
      name: "operon-notifications",
    }
  )
)
