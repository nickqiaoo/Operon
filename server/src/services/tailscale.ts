import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { isTailnetIPv4, type TailscaleInfo } from '@shared/delegations'

/**
 * What the user's Tailscale client says about this machine, and the one thing
 * changed in it: the Tailscale Serve entry that publishes this machine's
 * direct listener for phones (`publishServe` / `unpublishServe`), on a port of
 * its own so the user's own Serve entries are never touched. Nothing here
 * signs in or changes any other setting.
 *
 * The CLI is asked first (`tailscale status --json` reports whether the client
 * is signed in and connected). Without a CLI, a 100.64.0.0/10 address on a
 * network interface is taken as Tailscale's; that range is also carrier-grade
 * NAT, so it only counts when the interface looks like a tunnel.
 */

const CLI_CANDIDATES: Record<string, string[]> = {
  darwin: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale'],
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe'],
}
const STATUS_TIMEOUT_MS = 4_000
/** `serve --bg` returns once the entry is saved; it only waits when the tailnet must enable HTTPS first. */
const SERVE_TIMEOUT_MS = 15_000
/** The CLI inside the macOS app would otherwise open the app instead of acting as a CLI. */
const CLI_ENV = { ...process.env, TAILSCALE_BE_CLI: '1' }

let cachedCli: string | null | undefined

function findCli(): string | null {
  if (cachedCli !== undefined) return cachedCli
  const fromEnv = process.env.OPERON_TAILSCALE_CLI
  const candidates = [...(fromEnv ? [fromEnv] : []), ...(CLI_CANDIDATES[process.platform] ?? [])]
  cachedCli = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile() } catch { return false }
  }) ?? null
  return cachedCli
}

/** The fields of `tailscale status --json` read here. */
interface StatusJson {
  BackendState?: string
  CertDomains?: string[] | null
  TailscaleIPs?: string[] | null
  Self?: { DNSName?: string; TailscaleIPs?: string[] | null } | null
  Peer?: Record<string, { DNSName?: string; TailscaleIPs?: string[] | null; Online?: boolean } | null> | null
}

/** Another device on the tailnet, which may or may not run Operon. */
export interface TailnetPeer {
  ipv4: string
  dnsName?: string
}

/** Exported for tests. The tailnet's other devices that are online now. */
export function parseTailnetPeers(json: unknown): TailnetPeer[] {
  const status = (json && typeof json === 'object' ? json : {}) as StatusJson
  if (status.BackendState !== 'Running') return []
  const out: TailnetPeer[] = []
  for (const peer of Object.values(status.Peer ?? {})) {
    if (!peer?.Online) continue
    const ipv4 = (peer.TailscaleIPs ?? []).find((ip) => isTailnetIPv4(ip))
    if (!ipv4) continue
    const dnsName = peer.DNSName?.replace(/\.$/, '') || undefined
    out.push({ ipv4, ...(dnsName ? { dnsName } : {}) })
  }
  return out
}

let lastPeers: TailnetPeer[] = []

/** The online devices the last `detectTailscale()` saw (empty without a CLI). */
export function tailnetPeers(): TailnetPeer[] {
  return lastPeers
}

/** Exported for tests. */
export function parseTailscaleStatus(json: unknown): TailscaleInfo {
  const status = (json && typeof json === 'object' ? json : {}) as StatusJson
  const ips = status.Self?.TailscaleIPs ?? status.TailscaleIPs ?? []
  const ipv4 = ips.find((ip) => isTailnetIPv4(ip))
  const dnsName = status.Self?.DNSName?.replace(/\.$/, '') || undefined
  const https = Array.isArray(status.CertDomains) && status.CertDomains.length > 0
  switch (status.BackendState) {
    case 'Running':
      return ipv4 ? { state: 'running', ipv4, ...(dnsName ? { dnsName } : {}), https } : { state: 'stopped' }
    case 'NeedsLogin':
    case 'NeedsMachineAuth':
      return { state: 'needs_login' }
    default:
      return { state: 'stopped' }
  }
}

function runStatus(cli: string): Promise<TailscaleInfo | null> {
  return new Promise((resolve) => {
    execFile(cli, ['status', '--json'], { timeout: STATUS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: CLI_ENV }, (error, stdout) => {
      // A stopped client exits non-zero but still prints its status.
      if (!stdout) {
        resolve(error ? null : { state: 'stopped' })
        return
      }
      try {
        const json: unknown = JSON.parse(stdout)
        lastPeers = parseTailnetPeers(json)
        resolve(parseTailscaleStatus(json))
      } catch {
        resolve(null)
      }
    })
  })
}

/** Exported for tests. */
export function tailnetAddressFromInterfaces(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | undefined {
  for (const [name, addresses] of Object.entries(interfaces)) {
    // macOS: utunN; Linux: tailscale0; Windows: "Tailscale".
    if (!/^(utun\d+|tailscale\d*|Tailscale)/i.test(name)) continue
    const found = addresses?.find((address) => address.family === 'IPv4' && !address.internal && isTailnetIPv4(address.address))
    if (found) return found.address
  }
  return undefined
}

export async function detectTailscale(): Promise<TailscaleInfo> {
  const cli = findCli()
  if (cli) {
    const status = await runStatus(cli)
    if (status) return status
  }
  const ipv4 = tailnetAddressFromInterfaces(os.networkInterfaces())
  return ipv4 ? { state: 'running', ipv4 } : { state: 'not_found' }
}

// ── Tailscale Serve (the phone address) ────────────────────────────────────

/** The fields of `tailscale serve status --json` read here (ipn.ServeConfig). */
interface ServeJson {
  TCP?: Record<string, { HTTPS?: boolean } | undefined> | null
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string } | undefined> | null } | undefined> | null
}

/** Exported for tests. Where `httpsPort` proxies to, or null when Serve does not publish it. */
export function serveProxyFor(json: unknown, httpsPort: number): string | null {
  const config = (json && typeof json === 'object' ? json : {}) as ServeJson
  if (!config.TCP?.[String(httpsPort)]?.HTTPS) return null
  for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
    if (!hostPort.endsWith(`:${httpsPort}`)) continue
    const proxy = web?.Handlers?.['/']?.Proxy
    if (proxy) return proxy.replace(/\/$/, '')
  }
  return null
}

function runCli(args: string[], timeout: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const cli = findCli()
  if (!cli) return Promise.resolve({ ok: false, stdout: '', stderr: 'The Tailscale command line tool was not found on this machine.' })
  return new Promise((resolve) => {
    execFile(cli, args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true, env: CLI_ENV }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error?.message ?? '') })
    })
  })
}

/** Where Serve's `httpsPort` proxies to; null when it does not, undefined when Serve cannot be asked. */
export async function readServe(httpsPort: number): Promise<string | null | undefined> {
  const result = await runCli(['serve', 'status', '--json'], STATUS_TIMEOUT_MS)
  if (!result.ok) return undefined
  try {
    return serveProxyFor(JSON.parse(result.stdout || '{}'), httpsPort)
  } catch {
    return undefined
  }
}

/** Publish `target` (http://127.0.0.1:<port>) at https://<MagicDNS name>:<httpsPort>, kept across restarts. */
export async function publishServe(httpsPort: number, target: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await runCli(['serve', '--bg', `--https=${httpsPort}`, target], SERVE_TIMEOUT_MS)
  if (result.ok) return { ok: true }
  // Without HTTPS certificates the CLI prints where to turn them on.
  const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(`${result.stdout}\n${result.stderr}`)?.[0]
  return { ok: false, error: link ? `Turn on HTTPS certificates for your tailnet: ${link}` : firstLine(result.stderr) || 'Tailscale Serve failed' }
}

/** Remove only this machine's own Serve entry; never `serve reset`, which would drop the user's own. */
export async function unpublishServe(httpsPort: number): Promise<void> {
  await runCli(['serve', `--https=${httpsPort}`, 'off'], STATUS_TIMEOUT_MS)
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
}

export const tailscaleTestUtils = {
  resetCli(): void {
    cachedCli = undefined
    lastPeers = []
  },
}
