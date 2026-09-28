import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Ownership records for the `opencode serve` processes this app starts, so a
 * later launch can clean up the ones left behind.
 *
 * `createOpencodeServer` spawns the server as a child, and a child outlives a
 * parent that dies without unwinding: the usual case when the app is killed or
 * a dev restart replaces it. Correctness no longer depends on cleaning these up:
 * each launch starts its own server on a random port and never talks to one it
 * did not start (see client-manager.ts). A leftover is only a leaked process.
 *
 * Each record names the server and the app process that owns it, and only
 * servers whose owner is gone are stopped. Two apps can run at once (a dev
 * build next to the installed one, or two launches racing), and a record
 * without an owner would let one kill the server the other is using.
 */

const RECORD_PREFIX = 'opencode-server-'
const RECORD_SUFFIX = '.json'

export function defaultRunDir(): string {
  return path.join(os.homedir(), '.operon', 'run')
}

interface ServerRecord {
  serverPid: number
  ownerPid: number
}

function recordPath(dir: string, serverPid: number): string {
  return path.join(dir, `${RECORD_PREFIX}${serverPid}${RECORD_SUFFIX}`)
}

/**
 * The pid listening on `port`.
 *
 * Asked of the OS rather than the SDK: `createOpencodeServer` resolves to
 * `{ url, close }` and never exposes the child's pid.
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
    // No lsof, or nothing listening. Without a record the server can still leak
    // if we die hard, which costs memory and nothing else.
    return undefined
  }
}

export function recordServer(
  serverPid: number | undefined,
  ownerPid: number = process.pid,
  dir: string = defaultRunDir(),
): void {
  if (serverPid == null) return
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const record: ServerRecord = { serverPid, ownerPid }
    writeFileSync(recordPath(dir, serverPid), JSON.stringify(record), { mode: 0o600 })
  } catch {
    // Losing the record only means a leftover is not cleaned up later.
  }
}

export function forgetServer(serverPid: number | undefined, dir: string = defaultRunDir()): void {
  if (serverPid == null) return
  try {
    rmSync(recordPath(dir, serverPid), { force: true })
  } catch {
    // A stale record is re-validated before it is ever acted on.
  }
}

function readRecords(dir: string): Array<{ file: string; record: ServerRecord | null }> {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.startsWith(RECORD_PREFIX) && name.endsWith(RECORD_SUFFIX))
    .map((name) => {
      const file = path.join(dir, name)
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ServerRecord>
        const valid =
          Number.isInteger(parsed.serverPid) && Number(parsed.serverPid) > 0 &&
          Number.isInteger(parsed.ownerPid) && Number(parsed.ownerPid) > 0
        return { file, record: valid ? { serverPid: Number(parsed.serverPid), ownerPid: Number(parsed.ownerPid) } : null }
      } catch {
        return { file, record: null }
      }
    })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists but belongs to someone else. Still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Is `pid` alive *and* actually an opencode server?
 *
 * Pids are reused, so a recorded pid can name an unrelated process by the time
 * we read it back, and killing that would be far worse than leaking a server.
 * The command line is the confirmation.
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
 * Stop the servers left behind by app processes that are gone, and drop
 * records that no longer name a live opencode server. Servers whose owner is
 * still running are never touched. Returns the pids that were signalled.
 */
export function reapOrphanedServers(
  logger: { info: (message: string) => void; warn: (message: string) => void },
  dir: string = defaultRunDir(),
): number[] {
  const reaped: number[] = []
  for (const { file, record } of readRecords(dir)) {
    if (record == null) {
      rmSync(file, { force: true })
      continue
    }
    const { serverPid, ownerPid } = record
    if (ownerPid === process.pid || isAlive(ownerPid)) continue
    if (serverPid === process.pid || !isOpencodeServer(serverPid)) {
      rmSync(file, { force: true })
      continue
    }
    try {
      process.kill(serverPid, 'SIGTERM')
      reaped.push(serverPid)
      logger.info(`Stopped OpenCode server (pid ${serverPid}) left behind by app process ${ownerPid}`)
    } catch (error) {
      logger.warn(`Could not stop leftover OpenCode server (pid ${serverPid}): ${String(error)}`)
    }
    rmSync(file, { force: true })
  }
  return reaped
}
