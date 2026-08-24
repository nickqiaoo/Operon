import { contextBridge, ipcRenderer } from 'electron'
import type { OpenInIdeRequest, OpenInIdeResult } from '../src/types/open-in-ide.ts'
import type { OpenWithApp, OpenWithRequest, OpenWithResult } from '../src/types/open-with.ts'
import type { LocalServerProbe } from '../src/types/local-server.ts'

contextBridge.exposeInMainWorld('electronAPI', {
  // Server port discovery (needed to bootstrap HTTP client)
  getServerPort: () => ipcRenderer.invoke('server:get-port'),

  // Startup api token for the local server; null when auth is disabled.
  getServerToken: () => ipcRenderer.invoke('server:get-token'),

  // Native folder picker dialog (cannot migrate to HTTP)
  selectFolder: () => ipcRenderer.invoke('fs:select-folder'),

  // Open in IDE (Electron only)
  openInIde: (payload: OpenInIdeRequest): Promise<OpenInIdeResult> =>
    ipcRenderer.invoke('system:open-in-ide', payload),

  // "Open with…" — list installed editors/terminals + open the target in one
  listOpenWith: (): Promise<OpenWithApp[]> =>
    ipcRenderer.invoke('system:list-open-with'),
  openWith: (payload: OpenWithRequest): Promise<OpenWithResult> =>
    ipcRenderer.invoke('system:open-with', payload),

  // Probe known local ports (from browsing history) for liveness + title
  probeLocalServers: (ports: number[]): Promise<LocalServerProbe[]> =>
    ipcRenderer.invoke('system:probe-local-servers', ports),

  // Open external URL in system browser
  openExternal: (url: string) => ipcRenderer.invoke('system:open-external', url),

  // Analytics: report consent + distinct_id to the main process, which holds its
  // own events until it hears this (see captureNodeEvent in main.ts).
  syncAnalyticsId: (distinctId: string, optedOut: boolean) =>
    ipcRenderer.invoke('analytics:sync-id', distinctId, optedOut),

  // Logging
  getLogging: () => ipcRenderer.invoke('logging:get') as Promise<{ enabled: boolean; path: string }>,
  setLogging: (enabled: boolean) => ipcRenderer.invoke('logging:set', enabled),
  revealLogFile: () => ipcRenderer.invoke('logging:reveal'),
  readLogTail: () => ipcRenderer.invoke('logging:read-tail') as Promise<string>,

  // Auto-updater
  checkForUpdate: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdateStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: unknown, status: unknown) => callback(status)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  },

  // Notifications
  showNotification: (payload: { title: string; body: string }) =>
    ipcRenderer.invoke('notification:show', payload),
  isWindowFocused: () => ipcRenderer.invoke('notification:is-focused') as Promise<boolean>,

  // Annotation editor: a single persistent frameless child window the renderer
  // drives (position + reveal / hide) so it never flashes at creation.
  annotationEditor: {
    show: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('annotation-editor:show', bounds),
    hide: () => ipcRenderer.invoke('annotation-editor:hide'),
  },

  // Renderer-owned conversation geometry for the native Computer Use PiP host.
  computerUsePIP: {
    setHostLayout: (layout: {
      hostSessionID?: string
      visible: boolean
      anchorRect: { x: number; y: number; width: number; height: number }
    }) => ipcRenderer.send('computer-use-pip:host-layout', layout),
    /** PiP cannot render (missing macOS grant) — the renderer prompts for it. */
    onBlocked: (
      handler: (payload: { reason: string; displayName?: string; hostSessionID?: string }) => void,
    ) => {
      const listener = (
        _event: unknown,
        payload: { reason: string; displayName?: string; hostSessionID?: string },
      ) => handler(payload)
      ipcRenderer.on('computer-use-pip:blocked', listener)
      return () => ipcRenderer.off('computer-use-pip:blocked', listener)
    },
  },

  // Browser toolbar helpers (screenshot → clipboard, clear cookies/cache) +
  // Browser Use tab registration (maps our instanceId → guest webContents so the
  // IAB backend can drive it over CDP; see electron/browser-use-driver.ts).
  browser: {
    screenshotToClipboard: (dataUrl: string): Promise<boolean> =>
      ipcRenderer.invoke('browser:screenshot-to-clipboard', dataUrl),
    clearData: (partition: string, kinds: Array<'cookies' | 'cache'>): Promise<void> =>
      ipcRenderer.invoke('browser:clear-data', partition, kinds),
    registerTab: (instanceId: string, webContentsId: number, owner?: string): Promise<void> =>
      ipcRenderer.invoke('browser:register-tab', instanceId, webContentsId, owner),
    unregisterTab: (instanceId: string): Promise<void> =>
      ipcRenderer.invoke('browser:unregister-tab', instanceId),
    // Browser Use: main asks the renderer to open/close browser tabs (the tabs
    // store lives here, not in main). Reply on the same id.
    onRequest: (
      handler: (req: { id: number; action: string; payload: unknown }) => void
    ): (() => void) => {
      const listener = (_e: unknown, req: { id: number; action: string; payload: unknown }) =>
        handler(req)
      ipcRenderer.on('browser-use:request', listener)
      return () => ipcRenderer.removeListener('browser-use:request', listener)
    },
    respond: (res: { id: number; ok: boolean; result?: unknown; error?: string }): void => {
      ipcRenderer.send('browser-use:response', res)
    },
  },
})
