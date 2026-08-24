/**
 * Backend discovery for operon's browser SDK.
 *
 * Read `/tmp/operon-browser-use`, treat every entry as a candidate socket,
 * connect to each and call `getInfo()`, then filter by type. The IAB backend and
 * the extension share the directory and are told apart by `getInfo().type`, never
 * by path.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { backendSocketDir, BUILD_FLAVOR_ENV, type BrowserInfo } from "../wire.ts";
import { BackendConnection, connectPipe } from "./transport.ts";
import { resolveSessionId } from "./session.ts";

export interface DiscoveredBackend {
  info: BrowserInfo;
  conn: BackendConnection;
  socketPath: string;
}

interface NodeReplLike {
  env?: Record<string, string | undefined>;
}

/** The Operon build flavour this client expects. */
function expectedFlavor(): string | undefined {
  return (globalThis as { nodeRepl?: NodeReplLike }).nodeRepl?.env?.[BUILD_FLAVOR_ENV];
}

/**
 * Connect to every socket in the directory and call `getInfo()`. Anything that
 * fails to connect or answer is skipped silently: the directory can hold stale
 * sockets left by another process, and one bad entry must not fail discovery.
 */
export async function probeBackends(dir: string = backendSocketDir()): Promise<DiscoveredBackend[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return []; // No directory means no backends.
  }

  const results = await Promise.all(
    entries.map(async (entry): Promise<DiscoveredBackend | undefined> => {
      const socketPath = path.join(dir, entry);
      let conn: BackendConnection | undefined;
      try {
        conn = new BackendConnection(await connectPipe(socketPath));
        // getInfo is itself a session request: the backend reads session_id from
        // the params to decide what to echo.
        const info = await conn.sendSessionRequest<BrowserInfo>("getInfo", {}, 5000);
        if (typeof info?.id !== "string" || typeof info?.type !== "string") {
          conn.close();
          return undefined;
        }
        return { info, conn, socketPath };
      } catch {
        conn?.close();
        return undefined;
      }
    }),
  );
  return results.filter((r): r is DiscoveredBackend => r !== undefined);
}

/**
 * Filter IAB backends by session and flavour, closing the ones that do not belong
 * to this session.
 *
 * Extension and cdp backends have nothing to do with an app session or build
 * flavour: one Chrome extension serves whichever Operon desktop build is running
 * on the machine, so filtering it by flavour would discard it wrongly.
 */
export function filterForSession(backends: DiscoveredBackend[]): DiscoveredBackend[] {
  const sessionId = resolveSessionId();
  const flavor = expectedFlavor();

  const kept: DiscoveredBackend[] = [];
  const dropped: DiscoveredBackend[] = [];
  for (const b of backends) {
    if (b.info.type !== "iab") {
      kept.push(b);
      continue;
    }

    const meta = b.info.metadata;
    const ok =
      sessionId != null &&
      meta?.operonSessionId === sessionId &&
      (flavor == null || meta.operonBuildFlavor === flavor);
    (ok ? kept : dropped).push(b);
  }
  for (const b of dropped) b.conn.close();
  return kept;
}

/** Discover, then filter. */
export async function discoverBackends(dir?: string): Promise<DiscoveredBackend[]> {
  return filterForSession(await probeBackends(dir));
}
