import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Ownership record for an `opencode serve` process this app started.
 *
 * `createOpencodeServer` spawns the server as a child, but a child outlives a
 * parent that dies without unwinding — which is the normal case when the app is
 * quit or killed. The next app then finds port 4096 answering and reuses that
 * orphan, and the orphan is still holding MCP endpoints that point at the *old*
 * app's HTTP port. Since the app binds port 0 (a fresh random port per launch),
 * every one of those endpoints is dead, and every `node_repl` call in the new
 * session fails with "Unable to connect".
 *
 * The pid file is what makes "our orphan" distinguishable from "a server the
 * user started by hand". Only the former may be reclaimed.
 */

function pidFilePath(port: number): string {
  return path.join(os.homedir(), '.operon', 'run', `opencode-${port}.pid`)
}

/**
 * The pid listening on `port`.
 *
 * Asked of the OS rather than the SDK: `createOpencodeServer` resolves to
 * `{ url, close }` and never exposes the child's pid, so there is nothing to
 * record without looking it up.
 */
export function pidListeningOn(port: number): number | undefined {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      timeout: 2000,
    })
    const pid = Number.parseInt(out.split('\n')[0]?.trim() ?? '', 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    // No lsof, or nothing listening. Skipping the record only means the next
    // launch falls back to today's reuse behaviour.
    return undefined
  }
}

export function recordServerPid(port: number, pid: number | undefined): void {
  if (pid == null) return
  try {
    const file = pidFilePath(port)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, String(pid), { mode: 0o600 })
  } catch {
    // Losing the record only costs us the reclaim on the next launch.
  }
}

export function clearServerPid(port: number): void {
  try {
    rmSync(pidFilePath(port), { force: true })
  } catch {
    // Nothing to do: a stale file is re-validated before it is ever acted on.
  }
}

function readRecordedPid(port: number): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(pidFilePath(port), 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/**
 * Is `pid` alive *and* actually an opencode server?
 *
 * Both halves matter. Pids are reused, so a recorded pid can name an unrelated
 * process by the time we read it back, and killing that would be far worse than
 * the bug being fixed. The command line is the confirmation.
 */
function isOpencodeServer(pid: number): boolean {
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2000,
    })
    return /opencode\b/.test(command) && /\bserve\b/.test(command)
  } catch {
    // Non-zero exit means no such process.
    return false
  }
}

/**
 * Stop the orphaned server this app family left on `port`, if there is one.
 *
 * Returns true only when a process we recorded was confirmed and signalled, so
 * the caller can go on to start a fresh server. A server the user started by
 * hand has no pid file and is left running — the caller keeps its existing
 * reuse behaviour for that case.
 */
export function reclaimOrphanedServer(
  port: number,
  logger: { info: (message: string) => void; warn: (message: string) => void },
): boolean {
  const pid = readRecordedPid(port)
  if (pid == null) return false
  if (pid === process.pid) return false
  if (!isOpencodeServer(pid)) {
    clearServerPid(port)
    return false
  }
  try {
    process.kill(pid, 'SIGTERM')
    logger.info(`Reclaimed orphaned OpenCode server (pid ${pid}) left on port ${port} by a previous run`)
    clearServerPid(port)
    return true
  } catch (error) {
    logger.warn(`Could not stop orphaned OpenCode server (pid ${pid}): ${String(error)}`)
    return false
  }
}

/**
 * Wait for `port` to stop answering, so a restart does not race the old
 * process's socket. Resolves false if it is still up when the budget runs out.
 */
export async function waitForPortRelease(
  isRunning: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isRunning())) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}
