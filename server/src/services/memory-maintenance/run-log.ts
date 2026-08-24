import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type RunLogLevel = 'debug' | 'info' | 'warn' | 'error'

interface RunLogContext {
  runId: number
  stream: fs.WriteStream
}

const storage = new AsyncLocalStorage<RunLogContext>()

function logsDir(): string {
  return path.join(os.homedir(), '.operon', 'logs', 'memory-maintenance')
}

export function getRunLogPath(runId: number): string {
  return path.join(logsDir(), `run-${runId}.log`)
}

function ensureDir() {
  fs.mkdirSync(logsDir(), { recursive: true })
}

function fmt(level: RunLogLevel, scope: string, message: string): string {
  const ts = new Date().toISOString()
  return `${ts} [${level}] [${scope}] ${message}\n`
}

export function writeRunLog(level: RunLogLevel, scope: string, message: string): void {
  const ctx = storage.getStore()
  if (!ctx) return
  try {
    ctx.stream.write(fmt(level, scope, message))
  } catch {
    // best-effort; never crash the run because logging failed
  }
}

/**
 * Run `fn` with a per-run log file bound to the current async context.
 * Any `writeRunLog(...)` calls made inside `fn` (including inside awaited
 * work) append to `~/.operon/logs/memory-maintenance/run-{id}.log`.
 */
export async function withRunLog<T>(runId: number, fn: () => Promise<T>): Promise<T> {
  ensureDir()
  const stream = fs.createWriteStream(getRunLogPath(runId), { flags: 'a' })
  const ctx: RunLogContext = { runId, stream }
  stream.write(fmt('info', 'run-log', `=== run ${runId} started ===`))
  try {
    return await storage.run(ctx, fn)
  } finally {
    stream.write(fmt('info', 'run-log', `=== run ${runId} finished ===`))
    await new Promise<void>((resolve) => stream.end(resolve))
  }
}

export function readRunLog(runId: number): string | null {
  const p = getRunLogPath(runId)
  try {
    return fs.readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}
