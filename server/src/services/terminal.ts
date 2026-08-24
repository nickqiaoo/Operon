import * as pty from '@lydell/node-pty'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'

interface TerminalEntry {
  ptyProcess: pty.IPty
  onDataCallback: ((data: string) => void) | null
  onExitCallback: ((exit: { exitCode: number; signal?: number }) => void) | null
}

const terminals = new Map<string, TerminalEntry>()

function resolveCwd(cwd?: string): string {
  if (cwd) {
    try {
      const stat = fs.statSync(cwd)
      if (stat.isDirectory()) return cwd
    } catch {}
  }
  return os.homedir()
}

function resolveShellCandidate(shell?: string): string | null {
  if (!shell) return null
  const [candidate] = shell.trim().split(/\s+/)
  if (!candidate) return null
  return fs.existsSync(candidate) ? candidate : null
}

function getShellCandidates(): string[] {
  if (process.platform === 'win32') {
    const candidates = [process.env.COMSPEC, 'powershell.exe', 'cmd.exe'].filter(
      (item): item is string => Boolean(item)
    )
    return [...new Set(candidates)]
  }

  const candidates: string[] = []
  const envShell = resolveShellCandidate(process.env.SHELL)
  if (envShell) candidates.push(envShell)
  for (const sh of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(sh)) candidates.push(sh)
  }
  if (candidates.length === 0) {
    candidates.push('/bin/sh')
  }
  return [...new Set(candidates)]
}

function buildPtyEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  if (!env.TERM) {
    env.TERM = 'xterm-256color'
  }
  return env
}

function getShellArgs(shell: string): string[] {
  if (process.platform === 'win32') return []
  const name = path.basename(shell)
  if (['zsh', 'bash', 'fish'].includes(name)) return ['-i']
  return []
}

export function createTerminal(
  options?: { cwd?: string; cols?: number; rows?: number },
  onData?: (id: string, data: string) => void,
  onExit?: (id: string, exit: { exitCode: number; signal?: number }) => void
): string {
  const id = randomUUID()
  const shells = getShellCandidates()
  const cwd = resolveCwd(options?.cwd)
  const cols = options?.cols || 80
  const rows = options?.rows || 24
  const env = buildPtyEnv()

  let ptyProcess: pty.IPty | null = null
  let lastError: unknown = null
  for (const shell of shells) {
    try {
      ptyProcess = pty.spawn(shell, getShellArgs(shell), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        encoding: 'utf8',
        env,
      })
      break
    } catch (error) {
      lastError = error
    }
  }

  if (!ptyProcess) {
    if (lastError instanceof Error) {
      throw lastError
    }
    throw new Error('Failed to spawn terminal process')
  }

  const entry: TerminalEntry = {
    ptyProcess,
    onDataCallback: null,
    onExitCallback: null,
  }

  if (onData) {
    entry.onDataCallback = (data: string) => onData(id, data)
    ptyProcess.onData(entry.onDataCallback)
  }

  if (onExit) {
    entry.onExitCallback = (exit: { exitCode: number; signal?: number }) => onExit(id, exit)
    ptyProcess.onExit(entry.onExitCallback)
  }

  terminals.set(id, entry)
  return id
}

export function writeTerminal(id: string, data: string): boolean {
  const entry = terminals.get(id)
  if (!entry) return false
  entry.ptyProcess.write(data)
  return true
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const entry = terminals.get(id)
  if (!entry) return false
  entry.ptyProcess.resize(cols, rows)
  return true
}

export function closeTerminal(id: string): boolean {
  const entry = terminals.get(id)
  if (!entry) return false
  try {
    entry.ptyProcess.kill()
  } catch {}
  terminals.delete(id)
  return true
}

export function cleanupAllTerminals(): void {
  for (const [id, entry] of terminals) {
    try {
      entry.ptyProcess.kill()
    } catch {}
    terminals.delete(id)
  }
}

export function setTerminalCallbacks(
  id: string,
  onData: (id: string, data: string) => void,
  onExit: (id: string, exit: { exitCode: number; signal?: number }) => void
): boolean {
  const entry = terminals.get(id)
  if (!entry) return false
  entry.ptyProcess.onData((data) => onData(id, data))
  entry.ptyProcess.onExit((exit) => onExit(id, exit))
  return true
}
