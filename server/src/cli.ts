// `operon` — the command line of a headless node (a Linux server with no desktop).
//
//   operon serve                 run the node in the foreground (what the service runs)
//   operon service install       run it as a systemd user service, started at boot
//   operon node join <code>      sign in and pair, with a code from a signed-in machine
//
// Everything but `serve` and `service` is a thin client of the RUNNING node: it
// finds it through the discovery file the server publishes (plugin-server.json)
// and authenticates with the token file next to it, then calls the node's API.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { RemotePairingQrPayload, RemotePairingStatus } from '../../shared/e2ee/protocol.js'
import { getOperonHome } from '../../shared/operon-home.js'
import type { MobilePairingSummary } from './types/mobile.js'
import type { Project, Workspace } from './types/project.js'

declare const __OPERON_VERSION__: string | undefined

const SERVICE_NAME = 'operon'
const USAGE = `Usage: operon <command>

  serve                     Run this node in the foreground
  service install           Run it as a systemd user service (starts at boot, restarts on failure)
  service uninstall         Stop and remove the service
  service status            Show the service's state
  service logs              Follow the service's log

  node join <code>          Join your account and pair with the machine showing the code
                            (on that machine: Settings → Remote → Add a server)
      --label <name>        How this machine is listed (default: its hostname)
  node pair                 Show a pairing code to enter on another machine
  node pair <code>          Pair with the machine showing <code>
  node status               Account, connection and paired machines
  node logout               Take this machine off the account

  device pair               Pair a web browser or mobile app with this node
  project add [path]        Register a Git checkout as a project workspace (default: current directory)

  --version                 Print the version`

class CliError extends Error {}

function version(): string {
  if (typeof __OPERON_VERSION__ === 'string') return __OPERON_VERSION__
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    return (JSON.parse(fs.readFileSync(path.resolve(here, '../../package.json'), 'utf-8')) as { version: string }).version
  } catch {
    return 'dev'
  }
}

// ── Talking to the running node ─────────────────────────────────────────────

function localNode(): { base: string; token?: string } {
  const home = getOperonHome()
  let info: { url?: string; port?: number }
  try {
    info = JSON.parse(fs.readFileSync(path.join(home, 'plugin-server.json'), 'utf-8')) as { url?: string; port?: number }
  } catch {
    throw new CliError('operon is not running on this machine. Start it with `operon service install` (or `operon serve`).')
  }
  let token: string | undefined
  try {
    token = fs.readFileSync(path.join(home, 'run', 'api-token'), 'utf-8').trim() || undefined
  } catch {
    // The node runs with token auth disabled.
  }
  return { base: (info.url ?? `http://127.0.0.1:${info.port}`).replace(/\/$/, ''), token }
}

async function call<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const { base, token } = localNode()
  let response: Response
  try {
    response = await fetch(`${base}/api${route}`, {
      method,
      headers: { ...(token ? { 'x-operon-token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new CliError(`operon is not answering at ${base}. Is it running? Check \`operon service status\`.`)
  }
  const text = await response.text()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = undefined }
  if (!response.ok) {
    const error = parsed as { message?: string; error?: string } | undefined
    throw new CliError(error?.message ?? error?.error ?? `Request failed (HTTP ${response.status})`)
  }
  return parsed as T
}

interface Peer { nodeId: string; label?: string; fingerprint?: string }
interface Account {
  signedIn: boolean; running: boolean; online?: boolean
  userId?: string; nodeId?: string; label?: string; acceptingOtherMachines: boolean
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const value = args[i + 1]
  if (!value || value.startsWith('--')) throw new CliError(`${name} needs a value`)
  args.splice(i, 2)
  return value
}

async function nodeCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'join': {
      const label = flag(rest, '--label')
      const code = rest.join('')
      if (!code) throw new CliError('Usage: operon node join <code>  (get one on a signed-in machine: Settings → Remote → Add a server)')
      console.log('Joining…')
      const result = await call<{ nodeId: string; label: string; peer: Peer }>('POST', '/delegations/local/enroll/join', { code, label })
      console.log(`✓ Signed in as "${result.label}" (${result.nodeId})`)
      console.log(`✓ Paired with "${result.peer.label ?? result.peer.nodeId}"`)
      console.log('Other machines of the account can now open this one.')
      return
    }
    case 'pair': {
      const code = rest.join('')
      if (code) {
        const { peer } = await call<{ peer: Peer }>('POST', '/delegations/local/pair/join', { code })
        console.log(`✓ Paired with "${peer.label ?? peer.nodeId}"`)
        return
      }
      const shown = await call<{ code: string; expiresAt: number }>('POST', '/delegations/local/pair/code')
      console.log(`Enter this code on the other machine (Settings → Remote → Pair a machine):\n\n    ${shown.code}\n`)
      console.log('Waiting… (Ctrl-C to cancel)')
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        const status = await call<{ status: 'waiting' | 'paired' | 'expired'; peer?: Peer }>('GET', '/delegations/local/pair/code')
        if (status.status === 'paired') {
          console.log(`✓ Paired with "${status.peer?.label ?? status.peer?.nodeId}"`)
          return
        }
        if (status.status === 'expired') throw new CliError('The code expired. Run `operon node pair` again.')
      }
    }
    case 'status': {
      const account = await call<Account>('GET', '/delegations/local/account')
      if (!account.signedIn) {
        console.log('Not signed in. Run `operon node join <code>`.')
        return
      }
      console.log(`Machine:   ${account.label ?? '(unnamed)'} (${account.nodeId})`)
      console.log(`Broker:    ${account.online ? 'online' : account.running ? 'connecting…' : 'not connected'}`)
      console.log(`Others may use this machine: ${account.acceptingOtherMachines ? 'yes' : 'no'}`)
      const { peers } = await call<{ peers: Peer[] }>('GET', '/delegations/local/peers')
      console.log(`Paired:    ${peers.length ? peers.map((p) => p.label ?? p.nodeId).join(', ') : 'none'}`)
      return
    }
    case 'logout': {
      const { revoked } = await call<{ revoked: boolean }>('POST', '/delegations/local/account/leave')
      console.log(revoked
        ? '✓ Signed out. This machine is off the account.'
        : 'Signed out locally, but Broker could not be reached: remove this machine from another machine\'s Settings → Remote.')
      return
    }
    default:
      throw new CliError(USAGE)
  }
}

async function pairDevice(): Promise<void> {
  if (!process.stdin.isTTY) throw new CliError('Device pairing needs an interactive terminal. Over SSH, use `ssh -t`.')
  const code = await call<RemotePairingQrPayload>('POST', '/e2ee/pair/start')
  const session = `/e2ee/pair/session/${encodeURIComponent(code.pairingId)}`
  const expired = 'The pairing code expired. Run `operon device pair` again.'
  console.log('Select this machine in Operon, then paste the full code into "Paste pairing code" and select "Pair device":\n')
  console.log(JSON.stringify(code))
  console.log('\nWaiting for the device to request approval… (Ctrl-C to stop)')

  for (;;) {
    const { status, pairing } = await call<Pick<RemotePairingStatus, 'status'> & { pairing?: MobilePairingSummary }>('GET', session)
    if (status === 'expired') throw new CliError(expired)
    if (status === 'rejected') throw new CliError('The device pairing request was rejected.')
    if (status === 'confirmed') {
      console.log('✓ Device paired.')
      return
    }
    if (status === 'pending' && pairing) {
      const device = JSON.stringify(pairing.mobileLabel ?? pairing.mobileDeviceId)
      const terminal = createInterface({ input: process.stdin, output: process.stdout })
      let answer: string
      try {
        const signal = AbortSignal.timeout(Math.max(0, code.expiresAt - Date.now()))
        answer = await terminal.question(`Approve ${device} (${pairing.mobileFingerprint})? [y/N] `, { signal })
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw new CliError(expired)
        throw error
      } finally {
        terminal.close()
      }
      if (!/^y(es)?$/i.test(answer.trim())) {
        await call('POST', `${session}/reject`)
        console.log('Device pairing rejected.')
        return
      }
      await call('POST', `${session}/approve`)
      console.log(`✓ Paired with ${device}.`)
      return
    }
    await delay(1_000)
  }
}

async function addProject(directory: string): Promise<void> {
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  let rootPath: string
  let worktreePath: string
  let branchName: string
  try {
    worktreePath = git('rev-parse', '--show-toplevel').replace(/\r?\n$/, '')
    // Git lists the main checkout first, including when run in a linked worktree.
    rootPath = git('worktree', 'list', '--porcelain', '-z').split('\0', 1)[0].slice('worktree '.length)
    branchName = git('branch', '--show-current').trim()
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    throw new CliError(`Could not read Git checkout at ${JSON.stringify(directory)}: ${failure.stderr?.trim() || failure.message}`)
  }
  const { project, workspace } = await call<{ project: Project; workspace: Workspace }>('POST', '/projects/import', {
    project: { name: path.basename(rootPath), rootPath },
    workspace: { name: branchName || path.basename(worktreePath), branchName: branchName || 'detached', worktreePath },
  })
  console.log(`✓ Project ${JSON.stringify(project.name)} (${project.id}), workspace ${JSON.stringify(workspace.name)} (${workspace.id})`)
}

// ── Running as a service ────────────────────────────────────────────────────

function unitPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, 'systemd', 'user', `${SERVICE_NAME}.service`)
}

/** Shows a tool's own output; only a missing tool is an error (`systemctl status` exits non-zero for a stopped unit). */
function run(command: string, args: string[]): void {
  if (spawnSync(command, args, { stdio: 'inherit' }).error) {
    throw new CliError(`${command} is not available. Without systemd, run \`operon serve\` under your own process manager.`)
  }
}

function systemctl(...args: string[]): void {
  const result = spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' })
  if (result.error) throw new CliError('systemctl is not available. Run `operon serve` under your own process manager instead.')
  if (result.status !== 0) throw new CliError(`systemctl --user ${args.join(' ')} failed`)
}

/**
 * The unit runs this very CLI with `serve`, through the same Node and loader
 * flags it was started with, so a dev checkout (tsx) and an installed package
 * both work. PATH is copied in: a user service starts with systemd's minimal
 * PATH, and the agent CLIs the node launches (claude, codex, …) live wherever
 * the user's shell finds them.
 */
function unitFile(): string {
  const exec = [process.execPath, ...process.execArgv, path.resolve(process.argv[1] ?? ''), 'serve']
  const quote = (s: string) => (/[\s"\\]/.test(s) ? `"${s.replace(/(["\\])/g, '\\$1')}"` : s)
  const env = ['PATH', 'OPERON_HOME', 'OPERON_PORT', 'OPERON_DATA_DIR']
    .filter((key) => process.env[key])
    .map((key) => `Environment=${quote(`${key}=${process.env[key]}`)}`)
  return `[Unit]
Description=operon node
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${exec.map(quote).join(' ')}
${env.join('\n')}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
}

function serviceCommand(args: string[]): void {
  if (process.platform !== 'linux') throw new CliError('`operon service` manages a systemd service and only works on Linux.')
  const [sub] = args
  switch (sub) {
    case 'install': {
      const file = unitPath()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, unitFile())
      systemctl('daemon-reload')
      systemctl('enable', '--now', `${SERVICE_NAME}.service`)
      // Without lingering, a user service stops when the last SSH session closes.
      try {
        execFileSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'ignore' })
      } catch {
        console.warn('! Could not enable lingering; the service will stop when you log out.')
        console.warn(`  Fix it with: sudo loginctl enable-linger ${os.userInfo().username}`)
      }
      console.log(`✓ Installed and started (${file})`)
      console.log('Next: `operon node join <code>` — get the code on a signed-in machine: Settings → Remote → Add a server.')
      return
    }
    case 'uninstall': {
      spawnSync('systemctl', ['--user', 'disable', '--now', `${SERVICE_NAME}.service`], { stdio: 'inherit' })
      fs.rmSync(unitPath(), { force: true })
      systemctl('daemon-reload')
      console.log('✓ Service removed. Data in ~/.operon is kept.')
      return
    }
    case 'status':
      run('systemctl', ['--user', 'status', `${SERVICE_NAME}.service`])
      return
    case 'logs':
      run('journalctl', ['--user', '-u', `${SERVICE_NAME}.service`, '-f', '-n', '100'])
      return
    default:
      throw new CliError(USAGE)
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv
  switch (command) {
    case 'serve':
      await import('./headless.js')
      return
    case 'service':
      serviceCommand(args)
      return
    case 'node':
      await nodeCommand(args)
      return
    case 'device':
      if (args.length !== 1 || args[0] !== 'pair') throw new CliError('Usage: operon device pair')
      await pairDevice()
      return
    case 'project':
      if (args[0] !== 'add' || args.length > 2) throw new CliError('Usage: operon project add [path]')
      await addProject(args[1] ?? process.cwd())
      return
    case '--version':
    case '-v':
      console.log(version())
      return
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE)
      return
    default:
      throw new CliError(`Unknown command: ${command}\n\n${USAGE}`)
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof CliError ? error.message : error)
  process.exit(1)
})
