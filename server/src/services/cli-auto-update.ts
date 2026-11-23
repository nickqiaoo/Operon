// Daily self-update for the CLIs the Claude Code / Codex SDKs drive
// (shared/cli-auto-update.ts). The SDKs spawn the CLI the user installed, so
// an old CLI is what breaks a chat when a model or protocol moves on.
//
// Each CLI already knows how to update itself, whatever installed it:
// `claude update` (native installer or package manager) and `codex update`.
// We only run that once a day per enabled CLI and record what happened.
//
// Updating under a live session is safe: both CLIs install the new version
// next to the old one (or replace files a running process already has open),
// so a running chat keeps its process and the next session picks up the new one.

import { spawn } from 'node:child_process'
import process from 'node:process'
import {
  CLI_AUTO_UPDATE_ADAPTER_IDS,
  type CliAutoUpdateAdapterId,
  type CliAutoUpdateLastRun,
  type CliAutoUpdateState,
  type CliAutoUpdateStatus,
} from '../../../shared/cli-auto-update.js'
import type { StorageAdapter } from '../storage/interface.js'
import { getCliPathInfo, getShellEnv, invalidateCliVersionCache, probeCliVersion } from './adapter/bundled-cli-paths.js'

const KV_KEY = 'cli:auto_update'

const CHECK_INTERVAL_MS = 24 * 60 * 60_000
const TICK_INTERVAL_MS = 30 * 60_000
// Let startup (provider warm-up, first chats) settle before spawning updaters.
const FIRST_TICK_DELAY_MS = 2 * 60_000
// A package-manager update (npm / brew) can take a while on a slow network.
const UPDATE_TIMEOUT_MS = 10 * 60_000

const COMMANDS: Record<CliAutoUpdateAdapterId, string> = {
  'claude-code': 'claude',
  codex: 'codex',
}

interface StoredState {
  enabled?: Partial<Record<CliAutoUpdateAdapterId, boolean>>
  lastRun?: Partial<Record<CliAutoUpdateAdapterId, CliAutoUpdateLastRun>>
}

let storage: StorageAdapter | null = null
const running = new Set<CliAutoUpdateAdapterId>()

export function initCliAutoUpdateService(adapter: StorageAdapter): void {
  storage = adapter
}

function readState(): StoredState {
  return storage?.get<StoredState>(KV_KEY) ?? {}
}

function writeState(state: StoredState): void {
  storage?.set(KV_KEY, state)
}

export function getCliAutoUpdateStatus(adapterId: CliAutoUpdateAdapterId): CliAutoUpdateStatus {
  const state = readState()
  return {
    enabled: state.enabled?.[adapterId] === true,
    running: running.has(adapterId),
    lastRun: state.lastRun?.[adapterId],
  }
}

export function getCliAutoUpdateState(): CliAutoUpdateState {
  const result = {} as CliAutoUpdateState
  for (const id of CLI_AUTO_UPDATE_ADAPTER_IDS) result[id] = getCliAutoUpdateStatus(id)
  return result
}

export function setCliAutoUpdateEnabled(adapterId: CliAutoUpdateAdapterId, enabled: boolean): CliAutoUpdateStatus {
  const state = readState()
  state.enabled = { ...state.enabled, [adapterId]: enabled }
  writeState(state)
  // Turning it on should not wait up to a tick to do anything: check now if
  // the last check is a day old (or there never was one).
  if (enabled && isDue(adapterId)) void runCliUpdate(adapterId, 'scheduled')
  return getCliAutoUpdateStatus(adapterId)
}

function isDue(adapterId: CliAutoUpdateAdapterId, now = Date.now()): boolean {
  const last = readState().lastRun?.[adapterId]
  return !last || now - last.finishedAt >= CHECK_INTERVAL_MS
}

function recordRun(adapterId: CliAutoUpdateAdapterId, run: CliAutoUpdateLastRun): void {
  const state = readState()
  state.lastRun = { ...state.lastRun, [adapterId]: run }
  writeState(state)
}

async function readVersion(adapterId: CliAutoUpdateAdapterId): Promise<string | undefined> {
  invalidateCliVersionCache(adapterId)
  return (await probeCliVersion(adapterId)).version
}

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

function lastMeaningfulLine(text: string): string | undefined {
  return text
    .replace(ANSI_PATTERN, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
}

function runUpdateCommand(binaryPath: string): Promise<{ code: number | null; output: string; timedOut: boolean; spawnError?: string }> {
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    const child = spawn(binaryPath, ['update'], {
      // No TTY and no stdin: an updater that wants to ask something gets EOF
      // instead of hanging until the timeout.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...getShellEnv(), NO_COLOR: '1' },
    })
    const append = (chunk: Buffer) => {
      // Only the tail is ever shown; don't let a chatty npm grow this unbounded.
      output = (output + chunk.toString('utf8')).slice(-8_000)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, UPDATE_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, output, timedOut, spawnError: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output, timedOut })
    })
  })
}

/**
 * Run `<cli> update` once. Resolves with the recorded result; a second call
 * while one is running for the same CLI returns the current status instead of
 * starting another updater.
 */
export async function runCliUpdate(
  adapterId: CliAutoUpdateAdapterId,
  trigger: CliAutoUpdateLastRun['trigger'],
): Promise<CliAutoUpdateStatus> {
  if (running.has(adapterId)) return getCliAutoUpdateStatus(adapterId)
  running.add(adapterId)
  let run: CliAutoUpdateLastRun
  try {
    run = await performUpdate(adapterId, trigger)
  } catch (err) {
    run = {
      finishedAt: Date.now(),
      trigger,
      outcome: 'failed',
      error: `\`${COMMANDS[adapterId]} update\` failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    running.delete(adapterId)
  }
  recordRun(adapterId, run)
  console.log(
    `[cli-auto-update] \`${COMMANDS[adapterId]} update\` ${run.outcome}`
      + (run.outcome === 'updated' ? ` ${run.fromVersion} → ${run.toVersion}` : '')
      + (run.error ? ` — ${run.error}` : ''),
  )
  return getCliAutoUpdateStatus(adapterId)
}

async function performUpdate(
  adapterId: CliAutoUpdateAdapterId,
  trigger: CliAutoUpdateLastRun['trigger'],
): Promise<CliAutoUpdateLastRun> {
  const command = COMMANDS[adapterId]
  const resolvedPath = getCliPathInfo(adapterId).resolvedPath
  if (!resolvedPath) {
    return {
      finishedAt: Date.now(),
      trigger,
      outcome: 'failed',
      error: `\`${command}\` was not found, so there is nothing to update.`,
    }
  }

  const fromVersion = await readVersion(adapterId)
  console.log(`[cli-auto-update] ${trigger} \`${command} update\` (current ${fromVersion ?? 'unknown'})`)
  const result = await runUpdateCommand(resolvedPath)
  const toVersion = await readVersion(adapterId)
  const moved = Boolean(fromVersion && toVersion && fromVersion !== toVersion)

  if (result.code === 0) {
    return { finishedAt: Date.now(), trigger, outcome: moved ? 'updated' : 'up-to-date', fromVersion, toVersion }
  }

  const detail = result.spawnError
    ?? (result.timedOut ? `did not finish within ${UPDATE_TIMEOUT_MS / 60_000} minutes` : undefined)
    ?? lastMeaningfulLine(result.output)
    ?? `exited with code ${result.code}`
  return {
    finishedAt: Date.now(),
    trigger,
    // An updater can install the new version and then fail on cleanup; the
    // version is the truth about whether it moved.
    outcome: moved ? 'updated' : 'failed',
    fromVersion,
    toVersion,
    error: `\`${command} update\` failed: ${detail}`,
  }
}

/**
 * Checks every half hour whether an enabled CLI is due (last check a day old),
 * so a laptop that slept through the moment still updates soon after waking.
 * Runs the CLIs one after another, never two updaters at once.
 */
export function startCliAutoUpdateScheduler(): () => void {
  let ticking = false
  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      const state = readState()
      for (const id of CLI_AUTO_UPDATE_ADAPTER_IDS) {
        if (state.enabled?.[id] !== true || !isDue(id)) continue
        await runCliUpdate(id, 'scheduled')
      }
    } catch (err) {
      console.warn(`[cli-auto-update] tick failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      ticking = false
    }
  }

  const first = setTimeout(() => void tick(), FIRST_TICK_DELAY_MS)
  const timer = setInterval(() => void tick(), TICK_INTERVAL_MS)
  first.unref?.()
  timer.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
