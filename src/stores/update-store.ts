import { create } from "zustand"

interface UpdateStore {
  /**
   * Version that finished downloading and is waiting for a restart, if any.
   * Process-scoped on purpose: after a restart the installer either ran or
   * electron-updater re-downloads, so this must not be persisted.
   */
  downloadedVersion: string | null
  setDownloadedVersion: (version: string | null) => void
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  downloadedVersion: null,
  setDownloadedVersion: (downloadedVersion) => set({ downloadedVersion }),
}))

if (import.meta.env.DEV) {
  // The updater is disabled in dev (initAutoUpdater bails on VITE_DEV_SERVER_URL),
  // so this is the only way to exercise the "update ready" UI locally:
  //   __operonUpdateStore.getState().setDownloadedVersion('1.3.24')
  ;(globalThis as unknown as Record<string, unknown>).__operonUpdateStore = useUpdateStore
}
