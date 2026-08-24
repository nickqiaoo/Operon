/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import type { OpenInIdeRequest, OpenInIdeResult } from "@/types/open-in-ide"
import type { OpenWithApp, OpenWithRequest, OpenWithResult } from "@/types/open-with"
import type { LocalServerProbe } from "@/types/local-server"

type UpdateStatus =
  | { event: 'checking' }
  | { event: 'available'; version: string }
  | { event: 'not-available'; manual?: boolean; version?: string }
  | { event: 'progress'; percent: number }
  | { event: 'downloaded'; version: string }
  | { event: 'error'; message: string }

interface ElectronAPI {
  getServerPort: () => Promise<number>
  getServerToken: () => Promise<string | null>
  selectFolder: () => Promise<string | null>
  checkForUpdate: () => Promise<unknown>
  installUpdate: () => void
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
  openInIde: (payload: OpenInIdeRequest) => Promise<OpenInIdeResult>
  listOpenWith: () => Promise<OpenWithApp[]>
  openWith: (payload: OpenWithRequest) => Promise<OpenWithResult>
  probeLocalServers: (ports: number[]) => Promise<LocalServerProbe[]>
  openExternal: (url: string) => Promise<void>
  syncAnalyticsId: (distinctId: string, optedOut: boolean) => Promise<void>
  getLogging: () => Promise<{ enabled: boolean; path: string }>
  setLogging: (enabled: boolean) => Promise<void>
  revealLogFile: () => Promise<void>
  readLogTail: () => Promise<string>
  showNotification: (payload: { title: string; body: string }) => Promise<void>
  isWindowFocused: () => Promise<boolean>
  annotationEditor: {
    show: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
    hide: () => Promise<void>
  }
  computerUsePIP: {
    setHostLayout: (layout: {
      hostSessionID?: string
      visible: boolean
      anchorRect: { x: number; y: number; width: number; height: number }
    }) => void
    onBlocked: (
      handler: (payload: { reason: string; displayName?: string; hostSessionID?: string }) => void
    ) => () => void
  }
  browser: {
    screenshotToClipboard: (dataUrl: string) => Promise<boolean>
    clearData: (partition: string, kinds: Array<'cookies' | 'cache'>) => Promise<void>
    /** Browser Use: map instanceId → guest webContents so the IAB backend can drive it via CDP. */
    registerTab: (instanceId: string, webContentsId: number, owner?: string) => Promise<void>
    unregisterTab: (instanceId: string) => Promise<void>
    /** Browser Use: main asks the renderer to open/close browser tabs (tabs store lives here). */
    onRequest: (
      handler: (req: { id: number; action: string; payload: unknown }) => void
    ) => () => void
    respond: (res: { id: number; ok: boolean; result?: unknown; error?: string }) => void
  }
}

declare global {
  // Build target injected by vite `define` (see vite.config.ts). 'web' = browser
  // client talking to the cloud broker; 'electron' = desktop talking to localhost.
  const __APP_TARGET__: 'electron' | 'web'

  // True only in the Capacitor iOS build. Implies `__APP_TARGET__ === 'web'` —
  // the native shell is the web client packaged locally, not a third target.
  // Prefer `isNativeApp()` from `@/lib/native` over reading this directly.
  const __APP_NATIVE__: boolean

  interface ImportMetaEnv {
    /** Cloud broker base URL for the web target, e.g. https://broker.example.com */
    readonly VITE_BROKER_URL?: string
  }

  interface Window {
    electronAPI: ElectronAPI
  }
}

export { }
