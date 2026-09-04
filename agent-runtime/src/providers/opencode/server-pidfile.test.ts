// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearServerPid,
  pidListeningOn,
  reclaimOrphanedServer,
  recordServerPid,
  waitForPortRelease,
} from './server-pidfile.js'

/**
 * These decide whether a stray `kill` can reach the wrong process, so they run
 * against real processes and a real listening socket rather than mocks.
 *
 * Ports are in a private range and distinct per test so a developer's actual
 * OpenCode server (4096) is never the subject.
 */

const silentLogger = { info: () => {}, warn: () => {} }
const spawned: ChildProcess[] = []
const servers: Server[] = []
const usedPorts: number[] = []

/** A live process whose command line reads as an OpenCode server. */
function fakeOpencodeServer(port: number): ChildProcess {
  const child = spawn(
    'bash',
    ['-c', `exec -a "opencode serve --hostname=127.0.0.1 --port=${port}" sleep 30`],
    { stdio: 'ignore' },
  )
  spawned.push(child)
  return child
}

function unrelatedProcess(): ChildProcess {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  spawned.push(child)
  return child
}

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  for (const port of usedPorts.splice(0)) clearServerPid(port)
  for (const child of spawned.splice(0)) child.kill('SIGKILL')
  for (const server of servers.splice(0)) await new Promise((r) => server.close(() => r(null)))
})

function track(port: number): number {
  usedPorts.push(port)
  return port
}

describe('pidListeningOn', () => {
  it('finds the process holding a port', async () => {
    const port = track(59971)
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    expect(pidListeningOn(port)).toBe(process.pid)
  })

  it('returns undefined when nothing is listening', () => {
    expect(pidListeningOn(track(59972))).toBeUndefined()
  })
})

describe('reclaimOrphanedServer', () => {
  it('leaves a hand-started server alone: no pid record, no kill', async () => {
    const port = track(59973)
    const child = fakeOpencodeServer(port)
    await settle()
    // No recordServerPid call — this stands for a server the user started.
    expect(reclaimOrphanedServer(port, silentLogger)).toBe(false)
    await settle()
    expect(alive(child.pid!)).toBe(true)
  })

  it('stops a server this app recorded', async () => {
    const port = track(59974)
    const child = fakeOpencodeServer(port)
    await settle()
    recordServerPid(port, child.pid)

    expect(reclaimOrphanedServer(port, silentLogger)).toBe(true)
    await settle(500)
    expect(alive(child.pid!)).toBe(false)
  })

  it('never kills a recorded pid that now belongs to something else', async () => {
    const port = track(59975)
    // Pids get reused; a recorded one can name an unrelated process later.
    const child = unrelatedProcess()
    await settle()
    recordServerPid(port, child.pid)

    expect(reclaimOrphanedServer(port, silentLogger)).toBe(false)
    await settle()
    expect(alive(child.pid!), 'an unrelated process must survive').toBe(true)
  })

  it('clears a record whose process is already gone', async () => {
    const port = track(59976)
    const child = unrelatedProcess()
    const pid = child.pid!
    child.kill('SIGKILL')
    await settle()
    recordServerPid(port, pid)

    expect(reclaimOrphanedServer(port, silentLogger)).toBe(false)
    // The stale record is dropped, so it cannot be acted on once the pid is reused.
    expect(reclaimOrphanedServer(port, silentLogger)).toBe(false)
  })

  it('does nothing without a record', () => {
    expect(reclaimOrphanedServer(track(59977), silentLogger)).toBe(false)
  })

  it('refuses to signal the current process', () => {
    const port = track(59978)
    recordServerPid(port, process.pid)
    expect(reclaimOrphanedServer(port, silentLogger)).toBe(false)
  })
})

describe('waitForPortRelease', () => {
  it('resolves true once the port stops answering', async () => {
    let calls = 0
    const isRunning = async () => ++calls < 3
    await expect(waitForPortRelease(isRunning, 3000)).resolves.toBe(true)
  })

  it('resolves false while the port is still held', async () => {
    await expect(waitForPortRelease(async () => true, 400)).resolves.toBe(false)
  })
})
