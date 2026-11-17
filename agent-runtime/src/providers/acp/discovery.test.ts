import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeContext, type RuntimeContext } from '../../context.js'
import { ANTIGRAVITY_CONFIG } from '../antigravity/config.js'
import { probeAcpModels } from './discovery.js'
import type { AcpProviderConfig } from './types.js'

/**
 * A stand-in agent whose `session/new` hangs the way Antigravity's does while
 * a browser sign-in is open. It appends its pid to $MARKER on receiving
 * `session/new`, and only answers it on SIGUSR2 — "the user finished logging in".
 */
const AGENT_SCRIPT = `
const fs = require('fs')
const rl = require('readline').createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let pending = null
process.on('SIGUSR2', () => {
  if (pending !== null) send({ jsonrpc: '2.0', id: pending, result: { sessionId: 's1' } })
})
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, agentCapabilities: {}, authMethods: [] } })
  } else if (m.method === 'session/new') {
    pending = m.id
    process.stderr.write('Opening browser for sign-in\\n')
    fs.appendFileSync(process.env.MARKER, process.pid + '\\n')
  }
})
`

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met within 5s')
    await tick()
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('probeAcpModels sign-in parking', () => {
  let dir: string
  let marker: string
  let ctx: RuntimeContext
  const config: AcpProviderConfig = {
    ...ANTIGRAVITY_CONFIG,
    providerId: 'login-probe-test',
    agentArgs: ['-e', AGENT_SCRIPT],
    patchEnv: undefined,
  }

  const pids = (): number[] =>
    existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').map(Number) : []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    dir = mkdtempSync(join(tmpdir(), 'acp-probe-'))
    marker = join(dir, 'pids')
    ctx = createRuntimeContext({
      resolveBinary: () => process.execPath,
      env: () => ({ MARKER: marker }),
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await ctx.disposeShared()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps a probe stuck in session/new alive and does not spawn a second one', async () => {
    const first = probeAcpModels(ctx, config)
    await until(() => pids().length === 1)
    const [pid] = pids()

    await vi.advanceTimersByTimeAsync(12000)
    await expect(first).resolves.toEqual({ initialize: null, session: null, commands: null })
    expect(isAlive(pid)).toBe(true)

    // A refresh while the sign-in is open must not open another login page.
    await expect(probeAcpModels(ctx, config)).resolves.toEqual({ initialize: null, session: null, commands: null })
    expect(pids()).toHaveLength(1)

    // Sign-in completes: the parked process is retired, and probing resumes.
    process.kill(pid, 'SIGUSR2')
    await until(() => !isAlive(pid))
    const third = probeAcpModels(ctx, config)
    await until(() => pids().length === 2)
    // Park it too, so afterEach's dispose reaps it.
    await vi.advanceTimersByTimeAsync(12000)
    await third
  })

  it('kills a parked probe when the runtime is disposed', async () => {
    void probeAcpModels(ctx, config)
    await until(() => pids().length === 1)
    const [pid] = pids()
    await vi.advanceTimersByTimeAsync(12000)
    expect(isAlive(pid)).toBe(true)

    await ctx.disposeShared()
    await until(() => !isAlive(pid))
  })
})
