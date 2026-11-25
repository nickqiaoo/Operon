/**
 * Machines of one account using each other: one machine's UI opens another's
 * workspaces (`/api/remote/:nodeId/*`, end to end encrypted through Broker), and
 * a conversation on one machine can start an external agent on another.
 */

export const DELEGATION_NODE_ID = /^[0-9a-f]{32}$/
export const DELEGATION_PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export interface DelegationMachine {
  nodeId: string
  label: string
  online: boolean
  current: boolean
  /** Paired with this machine (see `MachinePeer`): only then can the two reach each other. */
  paired?: boolean
}

// ── Pairing between machines ────────────────────────────────────────────────
//
// Two machines trust each other only after pairing: one shows a code, the other
// enters it. The code never passes through Broker, and what the two exchange
// under it are their delegation public keys, which each then pins. From then on
// a request between them is sealed with keys derived from the pinned keys, so
// Broker relays it but cannot read or forge it. A machine that joins one member
// of the group is introduced to the rest by that member (`MachinePeerSync`).

/** Another machine this one trusts, or stopped trusting, as Remote settings shows it. */
export interface MachinePeer {
  nodeId: string
  label?: string
  /** Of its delegation public key: what the two machines show to compare, if ever in doubt. */
  fingerprint: string
  status: 'trusted' | 'revoked'
  /** Paired with a code on this machine, or vouched for by `introducedBy`. */
  source: 'paired' | 'introduced'
  introducedBy?: string
  changedAt: number
  lastSeenAt?: number
}

/** One machine's record of another in `MachinePeerSync`. */
export interface MachinePeerRecord {
  nodeId: string
  /** Base64 X25519 public key. */
  publicKey: string
  label?: string
  status: 'trusted' | 'revoked'
  /** When the record last changed; the later record of a machine wins. */
  changedAt: number
}

/**
 * POST /api/delegations/peers/sync (machine → machine): every machine the sender
 * trusts or revoked, so the receiver learns of machines that joined or left
 * through the sender. Accepted only from a paired machine, whatever the receive
 * switch says.
 */
export interface MachinePeerSync {
  peers: MachinePeerRecord[]
  /**
   * Where the sender itself can be reached directly over Tailscale
   * (`DirectLinkStatus.address`), or null when it does not listen. Absent from
   * builds that predate direct connections: the receiver keeps what it knew.
   */
  direct?: string | null
}
export const MACHINE_PEER_SYNC_PATH = '/api/delegations/peers/sync'

// ── Direct connections between machines (Tailscale) ─────────────────────────
//
// Two paired machines that are both on the user's tailnet can reach each other
// without Broker. The request is sealed exactly as it is through Broker, so the
// trust model does not change: Tailscale only carries it. Each machine listens
// on its own tailnet address only, and tells the machines it trusts where that
// is in `MachinePeerSync.direct`.

/** How this machine reaches one other machine. */
export type DirectRouteMode = 'auto' | 'direct' | 'broker'

/** This machine's view of its Tailscale client. */
export interface TailscaleInfo {
  /** `needs_login`: installed but signed out; `stopped`: signed in, disconnected. */
  state: 'running' | 'needs_login' | 'stopped' | 'not_found'
  /** Its tailnet IPv4 address, while running. */
  ipv4?: string
  /** Its MagicDNS name, e.g. `my-mac.tail1234.ts.net`. */
  dnsName?: string
  /**
   * Whether the tailnet issues HTTPS certificates (`CertDomains` in
   * `tailscale status --json`), which publishing an address for phones needs.
   * Turned on once per tailnet in the Tailscale admin console.
   */
  https?: boolean
}

/**
 * Phones reaching this machine over Tailscale. A phone's web view only takes
 * HTTPS without an exception, so the direct listener is published through
 * Tailscale Serve at `https://<MagicDNS name>:<httpsPort>`, which proxies to
 * the listener's loopback side. Pairing still goes through Broker.
 */
export interface DirectPhoneStatus {
  /** The user asked for phones to connect directly. */
  enabled: boolean
  httpsPort: number
  /** Where paired phones reach this machine, while it is published. */
  address?: string
  /** Why it is enabled but not published. */
  error?: string
  /** The tailnet does not issue HTTPS certificates yet (see `TailscaleInfo.https`). */
  needsHttps?: boolean
}

export interface DirectPeerStatus {
  nodeId: string
  /** Where that machine said it listens; absent until it says. */
  address?: string
  mode: DirectRouteMode
  /** What the last attempt used; `unknown` before any. */
  route: 'direct' | 'broker' | 'unknown'
  checkedAt?: number
  /** Why the direct route was not used, when it was not. */
  error?: string
}

export interface DirectLinkStatus {
  enabled: boolean
  port: number
  tailscale: TailscaleInfo
  /** Where the account's other machines reach this one, while it listens. */
  address?: string
  /** Why it is enabled but not listening. */
  error?: string
  peers: DirectPeerStatus[]
  phones: DirectPhoneStatus
  /** "Use Broker": off, everything goes directly. `signedIn`: this machine has an account to use it with. */
  broker: { enabled: boolean; signedIn: boolean }
}

/**
 * GET (sealed, from a paired phone or browser): where this machine can be
 * reached directly. The client keeps it and tries it before Broker.
 */
export const DIRECT_INFO_PATH = '/api/e2ee/direct'
export interface DirectInfo {
  /** `https://<name>.ts.net:<port>`, or null while not published. */
  address: string | null
}

/** Tailscale Serve publishes the phone address one port above the direct listener. */
export function directHttpsPort(port: number): number {
  return port + 1
}

/** A phone may only be pointed at HTTPS on a MagicDNS name. */
export function isPhoneDirectAddress(value: unknown): value is string {
  return isDirectAddress(value) && value.startsWith('https://') && /\.ts\.net:\d+$/i.test(value)
}

/** Answered by a machine's direct listener without authentication: which machine this is. */
export const DIRECT_PING_PATH = '/direct/ping'
/** What `DIRECT_PING_PATH` answers. `label` is what the machine calls itself, for finding it on the tailnet. */
export interface DirectPing {
  v: 1
  nodeId: string
  label?: string
}

/**
 * The id of a machine that never signed in to Broker: the first 128 bits of
 * SHA-256 over a fixed prefix and its delegation public key, in hex (the same
 * shape as Broker's ids). Broker accepts such an id only from a machine
 * registering that key (broker/auth_routes.go), so it cannot be claimed by
 * anyone who does not hold the key, and two machines share one only if they
 * share a key.
 */
export function localNodeIdFor(publicKey: Uint8Array, sha256: (data: Uint8Array) => Uint8Array): string {
  const prefix = new TextEncoder().encode('operon.node-id.v1\n')
  const data = new Uint8Array(prefix.length + publicKey.length)
  data.set(prefix)
  data.set(publicKey, prefix.length)
  return Array.from(sha256(data).subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export const DEFAULT_DIRECT_PORT = 47_420

/**
 * Whether `value` is a direct address another machine may point this one at:
 * plain http on a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48) or
 * a MagicDNS name, with an explicit port and no path. Anything else would let a
 * paired machine aim this one's requests at the user's LAN.
 */
export function isDirectAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 300) return false
  let url: URL
  try { url = new URL(value) } catch { return false }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.port || url.username || url.password) return false
  if (url.pathname !== '/' || url.search || url.hash || value.endsWith('/')) return false
  const host = url.hostname.toLowerCase()
  if (/^\[fd7a:115c:a1e0:/.test(host)) return true
  if (host.endsWith('.ts.net')) return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(host)
  return isTailnetIPv4(host)
}

/** 100.64.0.0/10, the range Tailscale assigns its IPv4 addresses from. */
export function isTailnetIPv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false
  const [a, b, c, d] = parts.map(Number)
  return a === 100 && b >= 64 && b <= 127 && c <= 255 && d <= 255
}

/**
 * POST /api/delegations/pair/claim (machine entering the code → machine showing
 * it). Not sealed by the transport (the two share no key yet) but under the
 * code: `envelope` opens with the key derived from it.
 */
export const MACHINE_PAIR_CLAIM_PATH = '/api/delegations/pair/claim'

/** What each side of a pairing tells the other, sealed under the code's key. */
export interface MachinePairHello {
  nodeId: string
  /** Base64 X25519 delegation public key. */
  publicKey: string
  label: string
  /** The claimer's random challenge; the answer echoes it back. */
  challenge: string
}

/** A pairing code this machine shows (Remote settings). */
export interface MachinePairingCode {
  code: string
  expiresAt: number
}

/** What became of the code this machine shows. */
export interface MachinePairingCodeStatus {
  status: 'waiting' | 'paired' | 'expired'
  peer?: MachinePeer
}

export interface DelegationWorkspace {
  id: number
  name: string
  project: string
}

/** Where an agent another machine started lives, as its origin shows it. */
export interface RemoteAgentLocation {
  /** The target machine's Broker node id. */
  nodeId: string
  /** Its label when the agent was created. */
  machine: string
  /** "project / workspace" on the target. */
  workspace: string
}

/** For Remote settings: an external agent of this machine that another machine started. */
export interface IncomingDelegation {
  childChatId: number
  sourceNodeId: string
  sourceLabel?: string
  providerId: string
  description: string
  workspace?: string
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'idle'
  updatedAt: number
}

// ── External agents across machines ─────────────────────────────────────────
//
// A conversation on one machine (the origin) starts an external agent on
// another (the target). The agent's conversation is an ordinary external agent
// of the target: its chat, workspace, turns and approvals are all there. The
// origin keeps a record of it for its parent conversation (the Agents card,
// `external_agent_send/stop/status`), and the target reports each turn back.

/** On the target: the conversation on another machine that started this agent. */
export interface RemoteAgentParent {
  /** The origin's Broker node id (stamped by Broker, never taken from a request body). */
  nodeId: string
  label?: string
  /** The parent conversation, a chat id on the origin. */
  chatId: number
}

/** POST /api/delegations/agents (origin → target) */
export interface DelegatedAgentCreate {
  parentChatId: number
  providerId: string
  model: string
  effort?: string
  description: string
  prompt: string
  workspaceId: number
}

/** What the target answers: its own ids, which the origin maps to its record. */
export interface DelegatedAgentStarted {
  childChatId: number
  workspaceId: number
  providerId: string
  modelId?: string
  effort?: string
  modeId?: string
  turnId: string
  status: 'running' | 'queued'
  delivery?: string
  warning?: string
}

/** POST /api/delegations/agents/:childChatId/(send|stop|status) — who is asking, on the origin. */
export interface DelegatedAgentCall {
  parentChatId: number
  prompt?: string
  mode?: 'auto' | 'steer' | 'followup'
}

/**
 * POST /api/delegations/agent-events (target → origin): a turn of the agent
 * started, or finished with its result. Accepted even while the origin does not
 * serve other machines, but only for agents it started there.
 */
export type DelegatedAgentEvent =
  | { type: 'settings'; childChatId: number; eventId: string; modelId?: string; effort?: string }
  | { type: 'turn'; childChatId: number; turnId: string; status: 'running' | 'queued' }
  | {
      type: 'result'
      childChatId: number
      turnId: string
      status: 'completed' | 'cancelled' | 'failed'
      error?: string
      /** The turn's prompt came from the parent agent, not from someone typing in the agent's chat. */
      dispatched: boolean
      prompt: string
      result: string
      /** Set when the agent works in a workspace of its own on the target. */
      workspace?: { id: number; branch: string; worktreePath: string }
    }

/** The one path another machine may call here while this machine serves no others. */
export const DELEGATED_AGENT_EVENTS_PATH = '/api/delegations/agent-events'

/** An origin's id for an agent it started on another machine: `ext-r<first 8 of node>-<child chat id>`. */
export const REMOTE_AGENT_ID = /^ext-r([0-9a-f]{8})-(\d+)$/

export function remoteAgentId(nodeId: string, childChatId: number): string {
  return `ext-r${nodeId.slice(0, 8)}-${childChatId}`
}

const NODE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * What another machine may never call here, even with receiving turned on: the
 * settings that decide who may reach this machine (paired devices, the Broker
 * connection, the receive switch itself), the relay on to a third machine, and
 * Broker's own webhook deliveries.
 */
const NODE_DENIED = /^\/api\/(e2ee|saas|remote|delegations\/local|integrations\/events)(\/|$)/

/**
 * Every path one machine may call on another (checked by the target and by
 * Broker). A machine that turned on "Let other machines use this one" serves the
 * account's other machines its whole API — files, git, terminal included — the
 * way it serves its own window.
 */
export function nodeDelegationRoute(method: string, path: string): boolean {
  if (!NODE_METHODS.has(method) || !path.startsWith('/api/')) return false
  const lower = path.toLowerCase()
  if (lower.includes('/../') || lower.endsWith('/..') || lower.includes('/./') || lower.includes('//') || lower.includes('\\')) return false
  return !NODE_DENIED.test(lower)
}
