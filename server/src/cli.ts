// `operon` — the command line of a headless node (a Linux server with no desktop).
//
//   operon serve                 run the node in the foreground (what the service runs)
//   operon service install       run it as a systemd user service, started at boot
//   operon node join <code>      sign in and pair, with a code from a signed-in machine
//
// Everything but `serve` and `service` is a thin client of the RUNNING node: it
// finds it through the discovery file the server publishes (plugin-server.json)
// and authenticates with the token file next to it, then calls the node's own
// local-only routes. So a join takes effect in the running process, no restart.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getOperonHome } from '../../shared/operon-home.js'

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
    response = await fetch(`${base}/api/delegations${route}`, {
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
      const result = await call<{ nodeId: string; label: string; peer: Peer }>('POST', '/local/enroll/join', { code, label })
      console.log(`✓ Signed in as "${result.label}" (${result.nodeId})`)
      console.log(`✓ Paired with "${result.peer.label ?? result.peer.nodeId}"`)
      console.log('Other machines of the account can now open this one.')
      return
    }
    case 'pair': {
      const code = rest.join('')
      if (code) {
        const { peer } = await call<{ peer: Peer }>('POST', '/local/pair/join', { code })
        console.log(`✓ Paired with "${peer.label ?? peer.nodeId}"`)
        return
      }
      const shown = await call<{ code: string; expiresAt: number }>('POST', '/local/pair/code')
      console.log(`Enter this code on the other machine (Settings → Remote → Pair a machine):\n\n    ${shown.code}\n`)
      console.log('Waiting… (Ctrl-C to cancel)')
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        const status = await call<{ status: 'waiting' | 'paired' | 'expired'; peer?: Peer }>('GET', '/local/pair/code')
        if (status.status === 'paired') {
          console.log(`✓ Paired with "${status.peer?.label ?? status.peer?.nodeId}"`)
          return
        }
        if (status.status === 'expired') throw new CliError('The code expired. Run `operon node pair` again.')
      }
    }
    case 'status': {
      const account = await call<Account>('GET', '/local/account')
      if (!account.signedIn) {
        console.log('Not signed in. Run `operon node join <code>`.')
        return
      }
      console.log(`Machine:   ${account.label ?? '(unnamed)'} (${account.nodeId})`)
      console.log(`Broker:    ${account.online ? 'online' : account.running ? 'connecting…' : 'not connected'}`)
      console.log(`Others may use this machine: ${account.acceptingOtherMachines ? 'yes' : 'no'}`)
      const { peers } = await call<{ peers: Peer[] }>('GET', '/local/peers')
      console.log(`Paired:    ${peers.length ? peers.map((p) => p.label ?? p.nodeId).join(', ') : 'none'}`)
      return
    }
    case 'logout': {
      const { revoked } = await call<{ revoked: boolean }>('POST', '/local/account/leave')
      console.log(revoked
        ? '✓ Signed out. This machine is off the account.'
        : 'Signed out locally, but Broker could not be reached: remove this machine from another machine\'s Settings → Remote.')
      return
    }
    default:
      throw new CliError(USAGE)
  }
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
