import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { startup } from 'vite-plugin-electron'

const devProcess: NodeJS.Process & {
  electronApp?: ChildProcess
  operonElectronRestart?: Promise<void>
} = process

async function replaceElectron(): Promise<void> {
  const child = devProcess.electronApp
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    // The plugin signals the process tree and removes its own exit handler.
    // Wait for the main process (which owns the HTTP server) to actually exit.
    await startup.exit()
    if (child.exitCode === null && child.signalCode === null) {
      const forceExit = setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
      try {
        await once(child, 'exit', { signal: AbortSignal.timeout(10_000) })
      } finally {
        clearTimeout(forceExit)
      }
    }
  }

  // startup() also stops the child it finds in this slot.
  delete devProcess.electronApp
  await startup()
}

export function restartDevElectron(): Promise<void> {
  // Keep the pending restart on the Vite process, including across config reloads.
  return devProcess.operonElectronRestart ??= replaceElectron()
    .catch((error: unknown) => console.error('[dev] Electron restart failed:', error))
    .finally(() => { delete devProcess.operonElectronRestart })
}

export function onDevPreloadBuild({ reload }: { reload: () => void }): void | Promise<void> {
  if (devProcess.operonElectronRestart || !devProcess.electronApp) {
    return restartDevElectron()
  }
  reload()
}
