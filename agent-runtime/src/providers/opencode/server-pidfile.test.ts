// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { forgetServer, pidListeningOn, reapOrphanedServers, recordServer } from './server-pidfile.js'

/**
 * These decide whether a stray `kill` can reach the wrong process, so they run
 * against real processes rather than mocks. Records go to a temp directory so
 * a developer's real ~/.operon/run is never read or reaped.
 */

const silentLogger = { info: () => {}, warn: () => {} }
const spawned: ChildProcess[] = []
const servers: Server[] = []
let dir = ''

/** A live process whose command line reads as an OpenCode server. */
function fakeOpencodeServer(): ChildProcess {
  const child = spawn('bash', ['-c', 'exec -a "opencode serve --hostname=127.0.0.1 --port=0" sleep 30'], {
    stdio: 'ignore',
  })
  spawned.push(child)
  return child
}

function sleeper(): ChildProcess {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  spawned.push(child)
  return child
}

/** A pid that has just exited, standing for an app that crashed. */
async function deadPid(): Promise<number> {
  const child = sleeper()
  const pid = child.pid!
  child.kill('SIGKILL')
  await new Promise((resolve) => child.once('exit', resolve))
  return pid
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
const records = () => readdirSync(dir).filter((name) => name.startsWith('opencode-server-'))

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'opencode-run-'))
})

afterEach(async () => {
  for (const child of spawned.splice(0)) child.kill('SIGKILL')
  for (const server of servers.splice(0)) await new Promise((r) => server.close(() => r(null)))
  rmSync(dir, { recursive: true, force: true })
})

describe('pidListeningOn', () => {
  it('finds the process holding a port', async () => {
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    expect(pidListeningOn(port)).toBe(process.pid)
  })
})

describe('reapOrphanedServers', () => {
  it('stops a server whose owning app is gone, and drops its record', async () => {
    const server = fakeOpencodeServer()
    await settle()
    recordServer(server.pid, await deadPid(), dir)

    expect(reapOrphanedServers(silentLogger, dir)).toEqual([server.pid])
    await settle(500)
    expect(alive(server.pid!)).toBe(false)
    expect(records()).toEqual([])
  })

  it('leaves a server alone while its owner is still running', async () => {
    // Two apps at once (a dev build next to the installed one): one must not
    // stop the server the other is using.
    const server = fakeOpencodeServer()
    const owner = sleeper()
    await settle()
    recordServer(server.pid, owner.pid, dir)

    expect(reapOrphanedServers(silentLogger, dir)).toEqual([])
    await settle()
    expect(alive(server.pid!)).toBe(true)
    expect(records()).toHaveLength(1)
  })

  it('leaves servers owned by this process alone', async () => {
    const server = fakeOpencodeServer()
    await settle()
    recordServer(server.pid, process.pid, dir)

    expect(reapOrphanedServers(silentLogger, dir)).toEqual([])
    expect(alive(server.pid!)).toBe(true)
  })

  it('never kills a recorded pid that now belongs to something else', async () => {
    // Pids get reused; a recorded one can name an unrelated process later.
    const unrelated = sleeper()
    await settle()
    recordServer(unrelated.pid, await deadPid(), dir)

    expect(reapOrphanedServers(silentLogger, dir)).toEqual([])
    await settle()
    expect(alive(unrelated.pid!), 'an unrelated process must survive').toBe(true)
    // Dropped, so it cannot be acted on later.
    expect(records()).toEqual([])
  })

  it('drops records whose server is already gone', async () => {
    recordServer(await deadPid(), await deadPid(), dir)
    expect(reapOrphanedServers(silentLogger, dir)).toEqual([])
    expect(records()).toEqual([])
  })

  it('drops unreadable records and ignores unrelated files', () => {
    writeFileSync(path.join(dir, 'opencode-server-123.json'), 'not json')
    writeFileSync(path.join(dir, 'other.sock'), '')
    expect(reapOrphanedServers(silentLogger, dir)).toEqual([])
    expect(readdirSync(dir)).toEqual(['other.sock'])
  })

  it('does nothing when the directory does not exist', () => {
    expect(reapOrphanedServers(silentLogger, path.join(dir, 'missing'))).toEqual([])
  })
})

describe('forgetServer', () => {
  it('removes the record for a server we closed', () => {
    recordServer(4242, process.pid, dir)
    forgetServer(4242, dir)
    expect(records()).toEqual([])
  })
})
