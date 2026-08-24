import { app, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { ComputerUsePresentationEvent } from '../packages/computer-use/presentation.ts'

interface ActivePresentation {
  hostSessionID?: string
  sessionID?: string
  turnID?: string
}

export interface ComputerUsePIPHostLayout {
  hostSessionID?: string
  visible: boolean
  anchorRect: {
    x: number
    y: number
    width: number
    height: number
  }
}

interface ComputerUsePIPNativeHost {
  attach(nativeWindowHandle: Buffer): boolean
  present(contextID: number, width: number, height: number): boolean
  setAnchorRect(x: number, y: number, width: number, height: number, visible: boolean): boolean
  setVisible(visible: boolean): boolean
  clear(): boolean
  dispose(): boolean
}

const require = createRequire(import.meta.url)

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function decodeComputerUsePIPHostLayout(value: unknown): ComputerUsePIPHostLayout | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const anchor = record.anchorRect
  if (typeof record.visible !== 'boolean' || anchor == null || typeof anchor !== 'object' || Array.isArray(anchor)) {
    return undefined
  }
  const anchorRecord = anchor as Record<string, unknown>
  const x = finiteNumber(anchorRecord.x)
  const y = finiteNumber(anchorRecord.y)
  const width = finiteNumber(anchorRecord.width)
  const height = finiteNumber(anchorRecord.height)
  if (x == null || y == null || width == null || height == null || width < 0 || height < 0) {
    return undefined
  }
  const hostSessionID = typeof record.hostSessionID === 'string' && record.hostSessionID.length > 0
    ? record.hostSessionID
    : undefined
  return {
    hostSessionID,
    visible: record.visible,
    anchorRect: { x, y, width, height },
  }
}

function loadNativeHost(): ComputerUsePIPNativeHost | undefined {
  if (process.platform !== 'darwin') return undefined
  const fileName = 'operon-computer-use-host.node'
  const candidates = [
    path.join(process.resourcesPath, 'operon-runtime', fileName),
    path.join(app.getAppPath(), 'dist-operon-runtime', fileName),
    path.join(app.getAppPath(), 'native', 'computer-use-host', 'build', 'Release', 'operon_computer_use_host.node'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      return require(candidate) as ComputerUsePIPNativeHost
    } catch (error) {
      console.warn(`[computer-use-pip] failed to load ${candidate}: ${String(error)}`)
    }
  }
  console.warn('[computer-use-pip] native host is unavailable')
  return undefined
}

/** Same controlled Computer Use session — turn_id may change between tools. */
function samePresentation(
  active: ActivePresentation | undefined,
  event: ComputerUsePresentationEvent,
): boolean {
  if (!active) return false
  if (event.hostSessionID && active.hostSessionID) {
    return event.hostSessionID === active.hostSessionID
  }
  if (event.sessionID && active.sessionID) {
    return event.sessionID === active.sessionID
  }
  if (event.sessionID && event.turnID && active.sessionID && active.turnID) {
    return event.sessionID === active.sessionID && event.turnID === active.turnID
  }
  return !event.hostSessionID && !event.sessionID && !event.turnID
}

function isNewControlledSession(
  active: ActivePresentation | undefined,
  event: ComputerUsePresentationEvent,
): boolean {
  if (!active) return true
  if (event.hostSessionID && active.hostSessionID) {
    return event.hostSessionID !== active.hostSessionID
  }
  if (event.sessionID && active.sessionID) {
    return event.sessionID !== active.sessionID
  }
  return !samePresentation(active, event)
}

export class ComputerUsePreviewController {
  private readonly parent: BrowserWindow
  private readonly host: ComputerUsePIPNativeHost | undefined
  private active: ActivePresentation | undefined
  private layout: ComputerUsePIPHostLayout | undefined
  private disposed = false

  constructor(parent: BrowserWindow) {
    this.parent = parent
    this.host = loadNativeHost()
    if (this.host && !this.host.attach(parent.getNativeWindowHandle())) {
      console.warn('[computer-use-pip] native host rejected the Electron window')
    }

    parent.on('show', this.reconcileVisibility)
    parent.on('restore', this.reconcileVisibility)
    parent.on('hide', this.reconcileVisibility)
    parent.on('minimize', this.reconcileVisibility)
  }

  setHostLayout(layout: ComputerUsePIPHostLayout): void {
    if (this.disposed) return
    this.layout = layout
    const { x, y, width, height } = layout.anchorRect
    this.host?.setAnchorRect(x, y, width, height, this.shouldShow())
  }

  handle(event: ComputerUsePresentationEvent): void {
    if (this.disposed) return

    if (event.type === 'active') {
      const reset = isNewControlledSession(this.active, event)
      this.active = {
        hostSessionID: event.hostSessionID,
        sessionID: event.sessionID,
        turnID: event.turnID,
      }
      if (reset) this.host?.clear()
      this.reconcileVisibility()
      return
    }

    // No frames are coming (missing Screen Recording). Keep the session active —
    // the engine re-checks and will publish a context if the user grants it —
    // but make sure nothing stale stays on screen.
    if (event.type === 'blocked') {
      this.host?.clear()
      this.reconcileVisibility()
      return
    }

    if (event.type === 'ended') {
      if (this.active && !samePresentation(this.active, event)) return
      this.active = undefined
      this.host?.clear()
      this.reconcileVisibility()
      return
    }

    if (this.active && !samePresentation(this.active, event)) return
    const { contextID, width, height } = event
    if (contextID == null || width == null || height == null) return
    this.active ??= {
      hostSessionID: event.hostSessionID,
      sessionID: event.sessionID,
      turnID: event.turnID,
    }
    this.host?.present(contextID, width, height)
    this.reconcileVisibility()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.parent.off('show', this.reconcileVisibility)
    this.parent.off('restore', this.reconcileVisibility)
    this.parent.off('hide', this.reconcileVisibility)
    this.parent.off('minimize', this.reconcileVisibility)
    this.host?.dispose()
  }

  private shouldShow(): boolean {
    if (
      !this.layout?.visible
      || !this.active
      || this.parent.isDestroyed()
      || !this.parent.isVisible()
      || this.parent.isMinimized()
    ) {
      return false
    }
    if (this.layout.hostSessionID && this.active.hostSessionID) {
      return this.layout.hostSessionID === this.active.hostSessionID
    }
    return true
  }

  private readonly reconcileVisibility = (): void => {
    this.host?.setVisible(this.shouldShow())
  }
}
