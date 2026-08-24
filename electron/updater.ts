import electronUpdater from 'electron-updater'
import { BrowserWindow } from 'electron'

const { autoUpdater } = electronUpdater

export type UpdateStatus =
  | { event: 'checking' }
  | { event: 'available'; version: string }
  | { event: 'not-available'; manual?: boolean; version?: string }
  | { event: 'progress'; percent: number }
  | { event: 'downloaded'; version: string }
  | { event: 'error'; message: string }

let manualCheckPending = false

function sendStatus(status: UpdateStatus) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updater:status', status)
  }
}

export function initAutoUpdater() {
  // Don't check in dev mode
  if (process.env.VITE_DEV_SERVER_URL) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    sendStatus({ event: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    manualCheckPending = false
    sendStatus({ event: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', (info) => {
    sendStatus({ event: 'not-available', manual: manualCheckPending, version: info.version })
    manualCheckPending = false
  })

  autoUpdater.on('download-progress', (progress) => {
    sendStatus({ event: 'progress', percent: progress.percent })
  })

  autoUpdater.on('update-downloaded', (info) => {
    sendStatus({ event: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    manualCheckPending = false
    sendStatus({ event: 'error', message: err.message })
  })

  // Check for updates 30s after launch, then every 4 hours
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {})
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {})
    }, 4 * 60 * 60 * 1000)
  }, 30_000)
}

export function checkForUpdates() {
  manualCheckPending = true
  return autoUpdater.checkForUpdates()
}

export function installUpdate() {
  autoUpdater.quitAndInstall(false, true)
}
