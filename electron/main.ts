import { app, BrowserWindow, ipcMain, dialog, session, shell, Menu, Notification, clipboard, nativeImage } from 'electron'
import { spawn, execFile } from 'child_process'
import http from 'node:http'
import fs from 'fs'
import os from 'node:os'
import path from 'path'
import { delimiter } from 'node:path'
import { fileURLToPath } from 'url'
import { shellEnvSync } from 'shell-env'
import { PostHog } from 'posthog-node'
import { createNodeAnalytics } from './analytics'
import { startServer } from '../server/src/start.js'
import { getApiToken, isApiTokenAuthDisabled } from '../server/src/services/api-token.js'
import { cleanupAllTerminals } from '../server/src/services/terminal.js'
import { SqliteVecStore } from '../server/src/services/vector/sqlite-vec-store.js'
import { stopComputerUsePresentationService } from '../server/src/services/computer-use-presentation.js'
import { disposeClaudeUsageProbe } from '@operon/agent-runtime'
import { initAutoUpdater, checkForUpdates, installUpdate } from './updater.js'
import { registerBrowserUseIpc, startIabBackend, stopIabBackend } from './browser-use-driver.js'
import {
  ComputerUsePreviewController,
  decodeComputerUsePIPHostLayout,
  type ComputerUsePIPHostLayout,
} from './computer-use-preview.js'

import { runChromeNativeHost } from '../packages/browser-use/chrome-native-host-main.ts'
import type { ComputerUsePresentationEvent } from '../packages/computer-use/presentation.ts'

declare const __ENABLE_MEMORY__: boolean
import type { OpenInIdeApp, OpenInIdeRequest, OpenInIdeResult } from '../src/types/open-in-ide.ts'
import type { OpenWithApp, OpenWithKind, OpenWithRequest, OpenWithResult } from '../src/types/open-with.ts'
import type { LocalServerProbe } from '../src/types/local-server.ts'

// —— Chrome native messaging host mode ——
//
// Chrome spawns this same binary with --chrome-native-host to talk to the Operon Chrome
// extension. That mode is not the app: no window, no server — just the relay, with stdout
// reserved for protocol frames.
//
// This runs directly below the imports so it wins before anything else can print. stdout is
// the pipe: runChromeNativeHost() takes it over synchronously, before its first await, so
// everything after this line — including any stray console.log further down — is already
// being redirected to stderr by the time it runs.
//
// Not awaited, and the module body deliberately keeps evaluating: the rest of this file only
// *registers* handlers, which is inert. What must not happen is booting, so `app.whenReady()`
// below is guarded on this flag instead. (An unresolved top-level await would be a tidier
// early exit, but esbuild targets es2020 for this bundle and rejects TLA outright — it fails
// the build rather than shipping, which is how this was caught.)
const IS_CHROME_NATIVE_HOST = process.argv.includes('--chrome-native-host')
if (IS_CHROME_NATIVE_HOST) {
  // Otherwise macOS bounces an icon into the dock for what should be an invisible pipe.
  try {
    app.dock?.hide()
  } catch {
    // Not fatal, and not worth failing the host over.
  }
  void runChromeNativeHost()
}

// On macOS, Electron apps launched from Finder have a minimal PATH that
// misses user-installed tools (Homebrew, nvm, etc.). Enrich process.env
// with the login shell's environment before anything else runs.
try {
  const shellEnv = shellEnvSync()
  // Merge PATH: prepend shell dirs that are missing from process.env.PATH
  if (shellEnv.PATH) {
    const currentDirs = new Set((process.env.PATH ?? '').split(delimiter))
    const additions = shellEnv.PATH.split(delimiter).filter(d => d && !currentDirs.has(d))
    if (additions.length > 0) {
      process.env.PATH = [...additions, process.env.PATH].join(delimiter)
    }
  }
  // Copy other shell env vars that are absent from process.env
  for (const [key, value] of Object.entries(shellEnv)) {
    if (key !== 'PATH' && !process.env[key] && value) {
      process.env[key] = value
    }
  }
} catch {
  // shellEnvSync can fail if the login shell is misconfigured — not fatal
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// --- File logging with toggle & size rotation ---
const LOG_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
const logFile = path.join(app.getPath('userData'), 'operon.log')
const logSettingsFile = path.join(app.getPath('userData'), 'log-settings.json')

function readLogSettings(): { enabled: boolean } {
  try {
    return JSON.parse(fs.readFileSync(logSettingsFile, 'utf-8'))
  } catch {
    return { enabled: false }
  }
}

function writeLogSettings(settings: { enabled: boolean }) {
  fs.writeFileSync(logSettingsFile, JSON.stringify(settings))
}

function rotateLogIfNeeded() {
  try {
    const stat = fs.statSync(logFile)
    if (stat.size >= LOG_MAX_BYTES) {
      const rotated = logFile + '.1'
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated)
      fs.renameSync(logFile, rotated)
    }
  } catch {
    // File doesn't exist yet, nothing to rotate
  }
}

let loggingEnabled = readLogSettings().enabled
let logStream: fs.WriteStream | null = null

function openLogStream() {
  if (logStream) return
  rotateLogIfNeeded()
  logStream = fs.createWriteStream(logFile, { flags: 'a' })
}

function closeLogStream() {
  if (!logStream) return
  logStream.end()
  logStream = null
}

function setLoggingEnabled(enabled: boolean) {
  loggingEnabled = enabled
  process.env.OPERON_VERBOSE = enabled ? '1' : ''
  writeLogSettings({ enabled })
  if (enabled) {
    openLogStream()
    logStream!.write(`[${ts()}] Logging enabled\n`)
  } else {
    logStream?.write(`[${ts()}] Logging disabled\n`)
    closeLogStream()
  }
}

if (loggingEnabled) openLogStream()
process.env.OPERON_VERBOSE = loggingEnabled ? '1' : ''

const origLog = console.log
const origError = console.error
const origWarn = console.warn
const origDebug = console.debug
// `info` too: the runtime loggers (createRuntimeLogger) send their info level
// here, so leaving it out silently dropped a whole class of diagnostics — the
// Claude usage probe's entire lifecycle never reached the log file.
const origInfo = console.info
const ts = () => new Date().toISOString()
console.log = (...args: unknown[]) => { if (loggingEnabled && logStream) { logStream.write(`[${ts()}] ${args.join(' ')}\n`) } origLog(...args) }
console.error = (...args: unknown[]) => { if (loggingEnabled && logStream) { logStream.write(`[${ts()}] ERROR ${args.join(' ')}\n`) } origError(...args) }
console.warn = (...args: unknown[]) => { if (loggingEnabled && logStream) { logStream.write(`[${ts()}] WARN ${args.join(' ')}\n`) } origWarn(...args) }
console.debug = (...args: unknown[]) => { if (loggingEnabled && logStream) { logStream.write(`[${ts()}] DEBUG ${args.join(' ')}\n`) } origDebug(...args) }
console.info = (...args: unknown[]) => { if (loggingEnabled && logStream) { logStream.write(`[${ts()}] ${args.join(' ')}\n`) } origInfo(...args) }
console.log(`--- Operon started (${process.execPath}) ---`)
console.log(`Log file: ${logFile}`)

let mainWindow: BrowserWindow | null = null
let serverPort: number | null = null
let computerUsePreview: ComputerUsePreviewController | null = null
let latestComputerUsePresentation: ComputerUsePresentationEvent | null = null
let latestComputerUsePIPHostLayout: ComputerUsePIPHostLayout | null = null

function isSameComputerUsePresentation(
  current: ComputerUsePresentationEvent,
  event: ComputerUsePresentationEvent,
): boolean {
  if (current.hostSessionID && event.hostSessionID) {
    return current.hostSessionID === event.hostSessionID
  }
  // Match conversation, not exact turn — PiP spans get_app_state + click in one chat.
  if (current.sessionID && event.sessionID) {
    return current.sessionID === event.sessionID
  }
  if (current.sessionID && current.turnID && event.sessionID && event.turnID) {
    return current.sessionID === event.sessionID && current.turnID === event.turnID
  }
  return !event.hostSessionID && !event.sessionID && !event.turnID
}

function handleComputerUsePresentationEvent(event: ComputerUsePresentationEvent): void {
  if (event.type === 'blocked') {
    // Live session that can never produce a frame — tell the renderer so it can
    // explain the empty PiP and offer the System Settings shortcut.
    console.warn(`[computer-use-pip] blocked: ${event.reason ?? 'unknown'}`)
    mainWindow?.webContents.send('computer-use-pip:blocked', {
      reason: event.reason ?? 'unknown',
      displayName: event.displayName,
      hostSessionID: event.hostSessionID,
    })
    computerUsePreview?.handle(event)
    return
  }
  if (event.type === 'ended') {
    if (
      latestComputerUsePresentation == null
      || isSameComputerUsePresentation(latestComputerUsePresentation, event)
    ) {
      latestComputerUsePresentation = null
    }
  } else {
    latestComputerUsePresentation = event
  }
  computerUsePreview?.handle(event)
}

const macAppNames: Record<OpenInIdeApp, string | null> = {
  vscode: 'Visual Studio Code',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  xcode: 'Xcode',
  zed: 'Zed',
  finder: null,
}

const cliByApp: Partial<Record<OpenInIdeApp, string>> = {
  vscode: 'code',
  cursor: 'cursor',
  zed: 'zed',
  xcode: 'xed',
}

const buildGotoTarget = (targetPath: string, line?: number, column?: number) => {
  if (!line) return targetPath
  if (!column) return `${targetPath}:${line}`
  return `${targetPath}:${line}:${column}`
}

const runCommand = (command: string, args: string[]): Promise<boolean> =>
  new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true })
      child.on('error', () => resolve(false))
      child.on('exit', (code) => resolve(code === 0))
      child.unref()
    } catch {
      resolve(false)
    }
  })

const openInIde = async (payload: OpenInIdeRequest): Promise<OpenInIdeResult> => {
  const targetPath = payload.targetPath.trim()
  if (!targetPath) {
    return { success: false, error: 'Missing target path' }
  }

  const resolvedPath = path.resolve(targetPath)
  const stat = await fs.promises.stat(resolvedPath).catch(() => null)
  if (!stat) {
    return { success: false, error: 'Target path not found' }
  }

  if (payload.app === 'finder') {
    if (stat.isDirectory()) {
      await shell.openPath(resolvedPath)
    } else {
      shell.showItemInFolder(resolvedPath)
    }
    return { success: true }
  }

  const cli = cliByApp[payload.app]
  const gotoTarget = buildGotoTarget(resolvedPath, payload.line, payload.column)
  if (cli) {
    const args = cli === 'xed' ? [resolvedPath] : (payload.line ? ['--goto', gotoTarget] : [resolvedPath])
    const cliOpened = await runCommand(cli, args)
    if (cliOpened) {
      return { success: true }
    }
  }

  if (process.platform === 'darwin') {
    const appName = macAppNames[payload.app]
    if (appName) {
      const opened = await runCommand('open', ['-a', appName, resolvedPath])
      if (opened) {
        return { success: true }
      }
    }
  }

  return { success: false, error: `Failed to open in ${payload.app}` }
}

// ---------------------------------------------------------------------------
// "Open with…" — macOS-only whitelist of editors/terminals. We resolve which
// candidates are installed, read each one's real icon (app.getFileIcon →
// data URL), and launch via `open -a <appPath> <targetPath>`.
// ---------------------------------------------------------------------------

interface OpenWithCandidate {
  id: string
  label: string
  /** The `.app` bundle's base name, e.g. "Visual Studio Code". */
  appName: string
  /** Decides file-open semantics (see OpenWithKind). */
  kind: OpenWithKind
}

// Order here is the menu order. Finder / Terminal / Xcode are system apps;
// the rest are detected only if installed.
const OPEN_WITH_CANDIDATES: OpenWithCandidate[] = [
  { id: 'vscode', label: 'VS Code', appName: 'Visual Studio Code', kind: 'editor' },
  { id: 'cursor', label: 'Cursor', appName: 'Cursor', kind: 'editor' },
  { id: 'windsurf', label: 'Windsurf', appName: 'Windsurf', kind: 'editor' },
  { id: 'zed', label: 'Zed', appName: 'Zed', kind: 'editor' },
  { id: 'sublime', label: 'Sublime Text', appName: 'Sublime Text', kind: 'editor' },
  { id: 'antigravity', label: 'Antigravity', appName: 'Antigravity', kind: 'editor' },
  { id: 'finder', label: 'Finder', appName: 'Finder', kind: 'finder' },
  { id: 'terminal', label: 'Terminal', appName: 'Terminal', kind: 'terminal' },
  { id: 'iterm', label: 'iTerm', appName: 'iTerm', kind: 'terminal' },
  { id: 'ghostty', label: 'Ghostty', appName: 'Ghostty', kind: 'terminal' },
  { id: 'warp', label: 'Warp', appName: 'Warp', kind: 'terminal' },
  { id: 'xcode', label: 'Xcode', appName: 'Xcode', kind: 'editor' },
  { id: 'idea', label: 'IntelliJ IDEA', appName: 'IntelliJ IDEA', kind: 'editor' },
  { id: 'goland', label: 'GoLand', appName: 'GoLand', kind: 'editor' },
  { id: 'webstorm', label: 'WebStorm', appName: 'WebStorm', kind: 'editor' },
  { id: 'pycharm', label: 'PyCharm', appName: 'PyCharm', kind: 'editor' },
]

const appSearchDirs = (): string[] => [
  '/Applications',
  path.join(os.homedir(), 'Applications'),
  '/System/Applications',
  '/System/Applications/Utilities', // Terminal
  '/System/Library/CoreServices', // Finder
]

const pathExists = (p: string): Promise<boolean> =>
  fs.promises.stat(p).then(() => true).catch(() => false)

/** Spotlight lookup by bundle file name; catches apps installed elsewhere. */
const mdfindAppPath = (fileName: string): Promise<string | null> =>
  new Promise((resolve) => {
    try {
      const child = spawn('mdfind', [`kMDItemFSName == '${fileName}'`])
      let out = ''
      child.stdout?.on('data', (d) => { out += d.toString() })
      child.on('error', () => resolve(null))
      child.on('close', () => {
        const first = out.split('\n').map((s) => s.trim()).find(Boolean)
        resolve(first ?? null)
      })
    } catch {
      resolve(null)
    }
  })

const resolveAppPath = async (appName: string): Promise<string | null> => {
  const fileName = `${appName}.app`
  for (const dir of appSearchDirs()) {
    const candidate = path.join(dir, fileName)
    if (await pathExists(candidate)) return candidate
  }
  return mdfindAppPath(fileName)
}

// Locate the bundle's .icns: prefer Info.plist's CFBundleIconFile, else the
// first .icns in Resources. (Info.plist may be binary — the regex just misses
// and we fall back to the directory scan.)
const findIcnsPath = (appPath: string): string | null => {
  const resDir = path.join(appPath, 'Contents', 'Resources')
  try {
    const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8')
    const match = plist.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/)
    if (match) {
      let name = match[1].trim()
      if (!name.toLowerCase().endsWith('.icns')) name += '.icns'
      const named = path.join(resDir, name)
      if (fs.existsSync(named)) return named
    }
  } catch { /* ignore */ }
  try {
    const icns = fs.readdirSync(resDir).find((f) => f.toLowerCase().endsWith('.icns'))
    return icns ? path.join(resDir, icns) : null
  } catch {
    return null
  }
}

// macOS `sips` converts .icns → png at a fixed box size, written to a temp file.
const sipsToPng = (icnsPath: string, outPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(
      'sips',
      ['-s', 'format', 'png', '-Z', '64', icnsPath, '--out', outPath],
      (error) => resolve(!error)
    )
  })

// Icons never change for a given bundle path, so cache them for the session.
// Electron's app.getFileIcon returns a generic placeholder on macOS and
// nativeImage can't decode .icns, so we read the bundle's .icns via `sips`.
const iconCache = new Map<string, string | null>()
const getAppIconDataUrl = async (appPath: string): Promise<string | null> => {
  const cached = iconCache.get(appPath)
  if (cached !== undefined) return cached

  let result: string | null = null
  const icnsPath = findIcnsPath(appPath)
  if (icnsPath) {
    const tmpPath = path.join(
      app.getPath('temp'),
      `operon-icon-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
    )
    if (await sipsToPng(icnsPath, tmpPath)) {
      try {
        const buffer = await fs.promises.readFile(tmpPath)
        if (buffer.length > 0) result = `data:image/png;base64,${buffer.toString('base64')}`
      } catch { /* ignore */ }
    }
    fs.promises.unlink(tmpPath).catch(() => { /* best-effort cleanup */ })
  }

  iconCache.set(appPath, result)
  return result
}

let openWithListCache: { at: number; apps: OpenWithApp[] } | null = null
const OPEN_WITH_LIST_TTL_MS = 5 * 60 * 1000

const listOpenWithApps = async (): Promise<OpenWithApp[]> => {
  if (process.platform !== 'darwin') return []
  if (openWithListCache && Date.now() - openWithListCache.at < OPEN_WITH_LIST_TTL_MS) {
    return openWithListCache.apps
  }
  const resolved = await Promise.all(
    OPEN_WITH_CANDIDATES.map(async (candidate) => {
      const appPath = await resolveAppPath(candidate.appName)
      if (!appPath) return null
      const iconDataUrl = await getAppIconDataUrl(appPath)
      return { id: candidate.id, label: candidate.label, appPath, iconDataUrl, kind: candidate.kind }
    })
  )
  const apps = resolved.filter((a): a is OpenWithApp => a != null)
  openWithListCache = { at: Date.now(), apps }
  return apps
}

const openWith = async (payload: OpenWithRequest): Promise<OpenWithResult> => {
  const targetPath = payload.targetPath?.trim()
  const appPath = payload.appPath?.trim()
  if (!targetPath || !appPath) return { success: false, error: 'Missing path' }

  const resolvedPath = path.resolve(targetPath)
  const stat = await fs.promises.stat(resolvedPath).catch(() => null)
  if (!stat) return { success: false, error: 'Target path not found' }

  // Directories open the same way for every app kind (`open -a` opens the
  // folder, terminals cd into it). Only *files* need kind-aware handling:
  // terminals and Finder can't open a file as a document — `open -a <terminal>
  // file.ts` raises a native "(null) has no permission" dialog — so we open the
  // file's parent dir (terminal) or reveal it (Finder) instead.
  const kind: OpenWithKind = payload.kind ?? 'editor'
  if (stat.isFile()) {
    if (kind === 'finder') {
      shell.showItemInFolder(resolvedPath)
      return { success: true }
    }
    if (kind === 'terminal') {
      const opened = await runCommand('open', ['-a', appPath, path.dirname(resolvedPath)])
      return opened ? { success: true } : { success: false, error: `Failed to open ${appPath}` }
    }
  }

  const opened = await runCommand('open', ['-a', appPath, resolvedPath])
  return opened ? { success: true } : { success: false, error: `Failed to open ${appPath}` }
}

// ---------------------------------------------------------------------------
// Local servers — codex-style browser landing. The renderer tracks which
// loopback addresses the user has actually opened (browsing history) and asks
// us to probe just those ports for liveness + page title. We never enumerate
// listening ports (that surfaced unrelated processes) and never start anything.
// ---------------------------------------------------------------------------

const extractHtmlTitle = (html: string): string => {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  return match ? match[1].trim() : ''
}

/** Probe `http://127.0.0.1:<port>/` for liveness + page title (short timeout). */
const probeLocalServer = (port: number): Promise<{ online: boolean; title: string }> =>
  new Promise((resolve) => {
    let settled = false
    const done = (online: boolean, title: string) => {
      if (settled) return
      settled = true
      resolve({ online, title })
    }
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
        if (body.length > 65536) {
          body = body.slice(0, 65536)
          res.destroy()
        }
      })
      res.on('end', () => done(true, extractHtmlTitle(body)))
      res.on('close', () => done(true, extractHtmlTitle(body)))
    })
    req.on('error', () => done(false, ''))
    req.on('timeout', () => {
      req.destroy()
      done(false, '')
    })
  })

/** Probe a known set of ports (from the renderer's browsing history). */
const probeLocalServers = (ports: number[]): Promise<LocalServerProbe[]> =>
  Promise.all(
    ports.map(async (port) => {
      const { online, title } = await probeLocalServer(port)
      return { port, online, title } satisfies LocalServerProbe
    })
  )

async function startHonoServer(): Promise<number> {
  const userData = app.getPath('userData')
  const migrationsDir = path.join(app.getAppPath(), 'server', 'src', 'storage', 'migrations')

  const { port } = await startServer({
    dbPath: path.join(userData, 'operon.db'),
    migrationsDir,
    port: 0,
    // Route server analytics through the existing main-process posthog-node client.
    // Buffered until the renderer reports consent and its distinct id via
    // 'analytics:sync-id', and inherits its `disabled: isDev` so dev runs no-op.
    captureAnalytics: (event, properties) => captureNodeEvent(event, properties),
    appVersion: app.getVersion(),
    onComputerUsePresentationEvent: handleComputerUsePresentationEvent,
    // Packaged clients never honor a local opt-out. The environment flag exists
    // only to make protocol debugging practical in an unpackaged desktop build.
    remoteE2eeMode: app.isPackaged
      ? 'required'
      : process.env.OPERON_REMOTE_E2EE === 'off' ? 'off' : 'required',
  })
  return port
}

const isDev = !!process.env.VITE_DEV_SERVER_URL

const phNode = new PostHog('phc_p9nI7Xag0whG3IcBUeO19m9FmCObKzJUDsz1jGcKep', {
  host: 'https://us.i.posthog.com',
  disabled: isDev,
})
// Holds main-process events until the renderer reports consent and identity;
// see electron/analytics.ts for why neither can be answered here.
const nodeAnalytics = createNodeAnalytics(phNode)

function captureNodeEvent(event: string, properties: Record<string, unknown>): void {
  nodeAnalytics.capture(event, properties)
}

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
  captureNodeEvent('app_crash', {
    process: 'main',
    type: 'uncaught_exception',
    message: error.message,
    stack: error.stack,
  })
  phNode.flush()
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
  captureNodeEvent('app_crash', {
    process: 'main',
    type: 'unhandled_rejection',
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  })
  phNode.flush()
})

const cleanupAll = () => {
  cleanupAllTerminals()
  computerUsePreview?.dispose()
  computerUsePreview = null
  void stopComputerUsePresentationService()
  // The IAB backend's socket file does not vanish on exit; leaving it behind makes
  // clients discover a dead backend they can't connect to.
  void stopIabBackend()
  // The Claude quota probe holds an idle CLI process.
  void disposeClaudeUsageProbe()
  if (__ENABLE_MEMORY__) {
    SqliteVecStore.getInstance()?.close()
  }
  phNode.shutdown()
}

process.on('SIGINT', () => {
  cleanupAll()
  if (isDev) {
    BrowserWindow.getAllWindows().forEach(w => w.destroy())
    process.exit(0)
  } else {
    app.quit()
  }
})
process.on('SIGTERM', () => {
  cleanupAll()
  if (isDev) {
    BrowserWindow.getAllWindows().forEach(w => w.destroy())
    process.exit(0)
  } else {
    app.quit()
  }
})

if (process.env.VITE_DEV_SERVER_URL) {
  app.commandLine.appendSwitch('remote-debugging-port', '9223')
}

/**
 * Lift Chromium's 6-sockets-per-origin cap for the local API.
 *
 * The renderer talks to one origin — `http://127.0.0.1:<port>/api` — over plain
 * HTTP/1.1, so it gets 6 sockets and no multiplexing. Anything holding a
 * connection open (an SSE subscription, a generating turn's response) spends one
 * for its whole life, and once 6 were spent every further request queued in the
 * socket pool behind connections that never close: the app looked frozen, not
 * slow.
 *
 * Two measured facts, so nobody re-derives them (harness: hanging requests to a
 * loopback HTTP/1.1 server that counts its own accepted sockets):
 *   - `--max-connections-per-host` does NOTHING here. 32, 99 and 256 all still
 *     capped at exactly 6 — it is parsed by Chrome-browser-layer code Electron
 *     does not ship. `hasSwitch()` returning true means nothing.
 *   - `--ignore-connections-limit` works: 40 of 40 and 120 of 120 opened.
 *
 * The value is matched as a plain host string with no loopback equivalence —
 * listing only `127.0.0.1` leaves requests to `localhost` still capped at 6 — so
 * both are listed. Must be set before `app` is ready.
 */
app.commandLine.appendSwitch('ignore-connections-limit', '127.0.0.1,localhost')

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      // Required so the browser sidebar can render <webview> tags.
      // Browser tabs share one persistent partition, matching Codex's separate
      // built-in-browser profile while keeping it isolated from the app session.
      webviewTag: true,
    }
  })
  computerUsePreview?.dispose()
  computerUsePreview = new ComputerUsePreviewController(mainWindow)
  if (latestComputerUsePIPHostLayout) {
    computerUsePreview.setHostLayout(latestComputerUsePIPHostLayout)
  }
  if (latestComputerUsePresentation) {
    computerUsePreview.handle(latestComputerUsePresentation)
  }
  mainWindow.on('closed', () => {
    computerUsePreview?.dispose()
    computerUsePreview = null
    mainWindow = null
  })

  // Inject our runtime preload into every browser-sidebar <webview> guest.
  // Leave sandbox at its default (on) to match the main-window preload: the
  // plugin builds preloads as CJS (`require`), which only works in a sandboxed
  // preload — a sandboxed preload can still use ipcRenderer and touch the guest
  // DOM (for the annotation capture overlay), it just can't use Node builtins.
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.preload = path.join(__dirname, 'webview-preload.mjs')
    webPreferences.contextIsolation = true
  })

  // The annotation comment editor is ONE persistent, frameless, transparent
  // child window (codex-style). The renderer opens it once via window.open and
  // reuses it for every annotation, driving position + reveal / hide entirely
  // over IPC (`annotation-editor:show` / `:hide`). Nothing is ever created per
  // click, so there is no creation-time flash to fight: the window is born
  // hidden, positioned with `setBounds` while hidden, and only then shown.
  let annotationEditorWindow: BrowserWindow | null = null
  // If a `show` arrives before `did-create-window` has tracked the window, stash
  // the bounds and apply them the moment the window appears (handles the race).
  let pendingEditorBounds: { x: number; y: number; width: number; height: number } | null = null

  const showAnnotationEditor = (bounds: { x: number; y: number; width: number; height: number }) => {
    const win = annotationEditorWindow
    if (win == null || win.isDestroyed()) {
      pendingEditorBounds = bounds
      return
    }
    win.setBounds(bounds)
    win.show()
  }

  mainWindow.webContents.setWindowOpenHandler(({ frameName }) => {
    if (frameName === 'operon-annotation-editor') {
      // Transparent, frameless child of the main window. The renderer draws a
      // rounded pill (collapsed) / card (design panel open) with its own CSS
      // shadow, so the window must be transparent for the shape to show (the
      // `#00000000` backgroundColor avoids the macOS transparent-window black
      // box). Width-locked (min===max) so the design panel can only grow it
      // vertically; height free between sane bounds.
      return {
        action: 'allow',
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          parent: mainWindow ?? undefined,
          frame: false,
          transparent: true,
          backgroundColor: '#00000000',
          hasShadow: false,
          resizable: true,
          show: false,
          minWidth: 360,
          maxWidth: 360,
          minHeight: 48,
          maxHeight: 720,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
        },
      }
    }
    return { action: 'allow' }
  })

  // `window.open` ignores `show: false`, so hide the window immediately on
  // creation (before its first paint), track it, and apply any bounds that a
  // `show` request beat the creation to.
  mainWindow.webContents.on('did-create-window', (childWindow, { frameName }) => {
    if (frameName !== 'operon-annotation-editor') return
    annotationEditorWindow = childWindow
    if (!childWindow.isDestroyed()) childWindow.hide()
    childWindow.on('closed', () => {
      if (annotationEditorWindow === childWindow) annotationEditorWindow = null
    })
    if (pendingEditorBounds != null) {
      const bounds = pendingEditorBounds
      pendingEditorBounds = null
      childWindow.setBounds(bounds)
      childWindow.show()
    }
  })

  ipcMain.handle('annotation-editor:show', (_e, bounds: { x: number; y: number; width: number; height: number }) => {
    showAnnotationEditor(bounds)
  })
  ipcMain.handle('annotation-editor:hide', () => {
    const win = annotationEditorWindow
    pendingEditorBounds = null
    if (win != null && !win.isDestroyed() && win.isVisible()) win.hide()
  })

  // Browser toolbar: copy a page screenshot to the OS clipboard.
  ipcMain.handle('browser:screenshot-to-clipboard', (_e, dataUrl: string) => {
    try {
      clipboard.writeImage(nativeImage.createFromDataURL(dataUrl))
      return true
    } catch {
      return false
    }
  })
  // Browser toolbar: clear cookies / cache for a webview's partition.
  ipcMain.handle(
    'browser:clear-data',
    async (_e, partition: string, kinds: Array<'cookies' | 'cache'>) => {
      const ses = session.fromPartition(partition)
      if (kinds.includes('cookies')) await ses.clearStorageData({ storages: ['cookies'] })
      if (kinds.includes('cache')) await ses.clearCache()
    }
  )

  // Browser Use: the renderer's body-level host registers every guest webContents,
  // independent of whether the React BrowserTab is mounted, so the IAB backend can
  // continue driving background conversations over CDP.
  registerBrowserUseIpc(mainWindow)
  // One global IAB backend for all sessions (echo mode). Must exist before any
  // agent asks for a browser: browser-client only ever *discovers* backends, it
  // never launches them.
  void startIabBackend()

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    // Opening DevTools in the same tick as loadURL() races the first layout and
    // can leave the DevTools window sized 0x0 — open, reachable over CDP, and
    // completely invisible. Wait for the page to finish loading, and pass an
    // explicit mode so a stale dock state can't decide it for us. Set
    // OPERON_NO_DEVTOOLS=1 to start without it.
    if (process.env.OPERON_NO_DEVTOOLS !== '1') {
      mainWindow.webContents.once('did-finish-load', () => {
        const wc = mainWindow?.webContents
        if (wc == null || wc.isDestroyed()) return
        // A previously-closed DevTools can linger in a state that makes
        // openDevTools() a no-op, so clear it first.
        if (wc.isDevToolsOpened()) wc.closeDevTools()
        wc.openDevTools({ mode: 'detach' })
      })
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
    // Right click -> Inspect Element (dev only)
  if (isDev) {
    mainWindow.webContents.on('context-menu', (_event, params) => {
      const menu = Menu.buildFromTemplate([
        {
          label: 'Inspect Element',
          click: () => {
            if (!mainWindow) return

            if (!mainWindow.webContents.isDevToolsOpened()) {
              mainWindow.webContents.openDevTools({ mode: 'detach' })
              mainWindow.webContents.once('devtools-opened', () => {
                mainWindow?.webContents.inspectElement(params.x, params.y)
              })
            } else {
              mainWindow.webContents.inspectElement(params.x, params.y)
            }
          },
        },
      ])

      menu.popup({ window: mainWindow ?? undefined })
    })
  }
  // Cmd+Shift+I to toggle DevTools in production
}

app.whenReady().then(async () => {
  // As a native messaging host we are a pipe, not the app: no window, no HTTP server, and
  // above all no second copy of the server fighting the real app for its port and database.
  if (IS_CHROME_NATIVE_HOST) return
  // Start Hono HTTP server
  serverPort = await startHonoServer()

  // SqliteVecStore is lazily initialized on first embedding call (auto-detects dimensions)

  ipcMain.handle('server:get-port', () => serverPort)
  // The api token travels renderer-ward over IPC only — never through a file a
  // web page or another app could discover. null = auth disabled (tests/dev).
  ipcMain.handle('server:get-token', () => (isApiTokenAuthDisabled() ? null : getApiToken()))
  ipcMain.on('computer-use-pip:host-layout', (event, value: unknown) => {
    if (event.sender !== mainWindow?.webContents) return
    const layout = decodeComputerUsePIPHostLayout(value)
    if (!layout) return
    latestComputerUsePIPHostLayout = layout
    computerUsePreview?.setHostLayout(layout)
  })
  ipcMain.handle('fs:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Auto-updater IPC handlers
  ipcMain.handle('updater:check', () => checkForUpdates())
  ipcMain.handle('updater:install', () => installUpdate())
  ipcMain.handle('system:open-in-ide', (_event, payload: OpenInIdeRequest) => openInIde(payload))
  ipcMain.handle('system:list-open-with', () => listOpenWithApps())
  ipcMain.handle('system:open-with', (_event, payload: OpenWithRequest) => openWith(payload))
  ipcMain.handle('system:probe-local-servers', (_event, ports: number[]) =>
    probeLocalServers(Array.isArray(ports) ? ports.filter((p) => Number.isInteger(p)) : [])
  )
  ipcMain.handle('system:open-external', (_event, url: string) => shell.openExternal(url))
  ipcMain.handle(
    'analytics:sync-id',
    (_event, distinctId: string, optedOut?: boolean) =>
      nodeAnalytics.applyRendererState(distinctId, optedOut === true)
  )

  // Logging toggle
  ipcMain.handle('logging:get', () => ({ enabled: loggingEnabled, path: logFile }))
  ipcMain.handle('logging:set', (_event, enabled: boolean) => { setLoggingEnabled(enabled) })
  ipcMain.handle('logging:reveal', () => { shell.showItemInFolder(logFile) })
  ipcMain.handle('logging:read-tail', () => {
    try {
      const content = fs.readFileSync(logFile, 'utf-8')
      const lines = content.split('\n')
      return lines.slice(-500).join('\n')
    } catch {
      return ''
    }
  })

  // Notification support
  ipcMain.handle('notification:show', (_event, payload: { title: string; body: string }) => {
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: payload.title,
      body: payload.body,
      silent: false,
    })
    notification.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
    })
    notification.show()
  })
  ipcMain.handle('notification:is-focused', () => {
    return mainWindow?.isFocused() ?? false
  })

  // Initialize auto-updater (no-op in dev mode)
  initAutoUpdater()

  // Build application menu with "Check for Updates"
  if (process.platform === 'darwin') {
    const appMenu: Electron.MenuItemConstructorOptions = {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => checkForUpdates(),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }
    const template: Electron.MenuItemConstructorOptions[] = [
      appMenu,
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  const blockExternal = process.env.OPERON_BLOCK_EXTERNAL !== 'false'
  const patchedSessions = new WeakSet<Electron.Session>()

  const applyNetworkBlock = (targetSession: Electron.Session) => {
    if (!isDev || !blockExternal) return
    if (patchedSessions.has(targetSession)) return
    patchedSessions.add(targetSession)

    targetSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const url = new URL(details.url)
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          const host = url.hostname
          if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
            || host.endsWith('.posthog.com')) {
            callback({ cancel: false })
            return
          }
          callback({ cancel: true })
          return
        }
      } catch {
        // Ignore malformed URLs.
      }
      callback({ cancel: false })
    })
  }

  applyNetworkBlock(session.defaultSession)
  applyNetworkBlock(session.fromPartition('persist:devtools'))
  applyNetworkBlock(session.fromPartition('devtools'))

  app.on('web-contents-created', (_event, contents) => {
    // The dev-mode external-network block is meant to keep the *app* from
    // accidentally talking to production services. The browser sidebar's
    // <webview> guests are user-driven tabs that should reach the real
    // internet, so opt them out.
    if (contents.getType() === 'webview') return
    applyNetworkBlock(contents.session)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  cleanupAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
