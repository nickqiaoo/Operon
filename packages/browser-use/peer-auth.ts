// Policy layer for code-signature peer verification, server side.
//
// It decides whether a socket connecting into IabBackend or ChromeNativeHost
// should be admitted: read the peer's code-signing identity from its audit token
// through the peer-auth native addon, and compare it against this process's own
// Team ID. Obtaining the identity lives in
// `native/peer-auth/src/peer_auth.mm`; this file is policy and graceful
// degradation only.
//
// Verification is one-way and server-side: no secret is ever sent to the peer.
//
// Off by default, adaptive, and never able to lock a developer out:
//   - `OPERON_REQUIRE_SIGNED_PEER` unset: no check at all.
//   - addon missing, or not macOS: warn once and admit.
//   - this process has no Team ID (a dev or adhoc build, `TeamIdentifier=not set`):
//     nothing to enforce against, so warn and admit.
//   - this process has a Team ID (a signed, notarised release): enforce, and
//     refuse a peer whose team is not on the allowlist.
//
// The positive path, accepting our own team and refusing others, can only be
// verified on a notarised build: everything on a development machine is adhoc.

import { createRequire } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";

interface PeerIdentity {
  teamIdentifier: string | null;
  signingIdentifier: string | null;
}

interface PeerAuthAddon {
  peerAuditIdentity(fd: number): PeerIdentity;
  selfAuditIdentity(): PeerIdentity;
}

const ENABLE_ENV = "OPERON_REQUIRE_SIGNED_PEER";
/** Additional Team IDs to admit, comma separated. Rarely needed; it exists for
 *  builds signed under more than one identity. */
const EXTRA_TEAMS_ENV = "OPERON_ALLOWED_PEER_TEAMS";

const require = createRequire(import.meta.url);

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[peer-auth] ${message}`);
}

function loadAddon(): PeerAuthAddon | undefined {
  if (process.platform !== "darwin") return undefined;
  const here = path.dirname(fileURLToPath(import.meta.url)); // packages/browser-use
  // resourcesPath is Electron-only and invisible to Node's types, hence the cast.
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const candidates = [
    // Packaged: ships inside resources alongside operon-runtime.
    ...(resourcesPath
      ? [path.join(resourcesPath, "operon-runtime", "operon-peer-auth.node")]
      : []),
    // Build output inside the repository.
    path.join(here, "..", "..", "dist-operon-runtime", "operon-peer-auth.node"),
    path.join(here, "..", "..", "native", "peer-auth", "build", "Release", "operon_peer_auth.node"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return require(candidate) as PeerAuthAddon;
    } catch (error) {
      warnOnce(`load:${candidate}`, `failed to load ${candidate}: ${String(error)}`);
    }
  }
  return undefined;
}

let addonCache: PeerAuthAddon | undefined | null = null; // null means not yet attempted
function addon(): PeerAuthAddon | undefined {
  if (addonCache === null) addonCache = loadAddon();
  return addonCache ?? undefined;
}

let allowedTeamsCache: Set<string> | undefined | null = null; // null means not yet computed
/** The allowlist is this process's own Team ID plus any configured extras.
 *  Returns undefined when this process has no Team ID, meaning nothing can be
 *  enforced. */
function allowedTeams(): Set<string> | undefined {
  if (allowedTeamsCache !== null) return allowedTeamsCache ?? undefined;
  const mod = addon();
  const selfTeam = mod?.selfAuditIdentity().teamIdentifier ?? null;
  if (!selfTeam) {
    allowedTeamsCache = undefined;
    return undefined;
  }
  const extra = (process.env[EXTRA_TEAMS_ENV] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  allowedTeamsCache = new Set([selfTeam, ...extra]);
  return allowedTeamsCache;
}

/** The unix socket's underlying fd (`_handle.fd`), or undefined when unavailable. */
export function socketFd(socket: Socket): number | undefined {
  const handle = (socket as unknown as { _handle?: { fd?: number } })._handle;
  const fd = handle?.fd;
  return typeof fd === "number" && fd >= 0 ? fd : undefined;
}

/**
 * Whether to admit a connection; see the policy at the top of this file.
 *
 * It fails open: anything undecidable, whether the switch is off, the addon is
 * missing, this process is unsigned, or the fd cannot be read, is admitted. This
 * is defence in depth layered on top of 0700 and 0600 permissions, and a false
 * negative must not break the product.
 */
export function authorizePeer(socket: Socket): boolean {
  if (!process.env[ENABLE_ENV]) return true;

  const mod = addon();
  if (!mod) {
    warnOnce("no-addon", `${ENABLE_ENV} set but peer-auth addon unavailable; allowing (cannot enforce)`);
    return true;
  }

  const teams = allowedTeams();
  if (!teams) {
    warnOnce("unsigned-self", `${ENABLE_ENV} set but this build is unsigned (no Team ID); allowing (cannot enforce)`);
    return true;
  }

  const fd = socketFd(socket);
  if (fd == null) {
    warnOnce("no-fd", "could not read socket fd; allowing (cannot enforce)");
    return true;
  }

  const peerTeam = mod.peerAuditIdentity(fd).teamIdentifier;
  if (peerTeam && teams.has(peerTeam)) return true;
  console.warn(`[peer-auth] rejected connection: peer team ${peerTeam ?? "<none>"} not in allowlist`);
  return false;
}
