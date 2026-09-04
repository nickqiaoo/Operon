/**
 * Whether the extension is actually there, asked of the running system.
 *
 * ## Why not read Chrome's profile registry
 *
 * The obvious check — read `Secure Preferences` and look for our id — needs Full
 * Disk Access, because macOS keeps Chrome's profile data behind it. That grant is
 * wildly out of proportion to a settings row (see `chrome-fs-access.ts`), so the
 * registry read stays best-effort and this is the answer that carries the page.
 *
 * ## What this observes instead
 *
 * Chrome spawns `operon --chrome-native-host` when, and only when, the extension
 * calls `connectNative()`. That host publishes a socket under
 * `/tmp/operon-browser-use/`, and asking it `getInfo()` reaches the extension
 * itself. A reply is proof of the whole chain at once: the extension is
 * installed, enabled, Chrome is running, and it has reached us — plus the id and
 * version it is actually running, which the registry cannot tell us either.
 * Nothing on disk gets close: a registry entry is still just an entry when the
 * user is in another profile, an enterprise policy blocked the extension, or
 * Chrome is simply not open.
 *
 * ## Why `getInfo` rather than a record the host writes
 *
 * The first version had each host write a status file on startup. It worked, and
 * it was useless in practice: the host is spawned by Chrome, so it keeps running
 * the binary it was started with, and a freshly built Operon cannot make an
 * already-connected extension re-announce itself. Measured against a host from an
 * older build: the status file stayed empty for as long as the process lived,
 * while `getInfo` answered immediately. Asking costs one connection and works
 * against every version, so nothing has to be deployed for this to start working.
 *
 * `getInfo` is also the same call the browser client uses for discovery, so the
 * extension already treats it as routine, and it is read-only — it cannot perturb
 * a session that happens to be driving the user's browser at the time.
 *
 * ## And when Chrome is closed
 *
 * Absence proves nothing on its own, so a timestamp outlives the connections:
 * "last connected 3 minutes ago" and "never connected" are very different
 * answers, and only the second suggests the extension is missing. It is written
 * from both ends — by the host as it starts and stops, which covers the times the
 * Operon app is not even running, and by this module whenever it observes a live
 * connection, which covers hosts too old to write it themselves.
 *
 * Everything here lives under `~/.operon` and `/tmp`, never inside Chrome's
 * directory, so none of it needs a grant of any kind.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { backendSocketDir, decodeFrames, encodeFrame } from "./wire.ts";

/** Root for everything this module writes. Mirrors the native host wrapper's home. */
export function presenceDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".operon", "chrome");
}

function lastSeenFile(homeDir: string): string {
  return path.join(presenceDir(homeDir), "last-seen.json");
}

/** One connected extension, as it described itself. */
export interface ConnectedExtension {
  /** The Web Store or unpacked id it is actually running under. */
  extensionId: string | null;
  version: string | null;
  /** Chrome profile name, when the extension reports one. */
  profileName: string | null;
}

export interface ChromePresence {
  /**
   * The extension answered just now. Proof it is installed, enabled, and
   * connected — an answer the profile registry cannot give at any price.
   */
  connected: boolean;
  /** One per connecting Chrome profile; Chrome spawns a host for each. */
  extensions: ConnectedExtension[];
  /**
   * Epoch ms of the most recent connection, or null if the extension has never
   * reached us. Null with the feature switched on is the real "probably not
   * installed" signal — much stronger than a registry we were not allowed to read.
   */
  lastSeenAt: number | null;
}

/**
 * Ask every backend socket who it is, and keep the Chrome extensions.
 *
 * The socket directory is shared with Operon's own in-app browser, and
 * `getInfo().type` is what tells them apart — `"extension"` is Chrome, `"iab"` is
 * ours. Probing in parallel because a dead socket costs the full timeout and
 * several accumulate over a session.
 */
export async function readChromePresence(
  homeDir: string = os.homedir(),
): Promise<ChromePresence> {
  const results = await Promise.all(
    listSocketPaths().map((socketPath) => probe(socketPath)),
  );
  const extensions = results.filter((r) => r != null);

  if (extensions.length > 0) {
    // Covers a host too old to record this itself, which is every host started
    // before this code shipped — and they outlive deployments by design.
    writeLastSeen(homeDir);
  }

  return {
    connected: extensions.length > 0,
    extensions,
    lastSeenAt: extensions.length > 0 ? Date.now() : readLastSeen(homeDir),
  };
}

function listSocketPaths(): string[] {
  const dir = backendSocketDir();
  try {
    return fs.readdirSync(dir).map((name) => path.join(dir, name));
  } catch {
    return []; // Directory absent: no backend has ever run.
  }
}

/**
 * One request/response over a backend socket. Resolves null for anything that is
 * not a live Chrome extension — a stale socket file, Operon's own browser, a host
 * that never answers.
 */
function probe(socketPath: string, timeoutMs = 1500): Promise<ConnectedExtension | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;

    const finish = (result: ConnectedExtension | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    // A socket that connects but never replies must not hold the settings page.
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.once("error", () => finish(null));
    socket.once("close", () => finish(null));

    socket.once("connect", () => {
      socket.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getInfo" })));
    });

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { messages, remainingData } = decodeFrames(buffer);
      buffer = remainingData;
      for (const message of messages) {
        finish(parseInfo(message));
        return;
      }
    });
  });
}

/** Keep only Chrome extensions; `iab` is Operon's own browser on the same socket dir. */
function parseInfo(message: string): ConnectedExtension | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  const result = (parsed as { result?: unknown }).result;
  if (result == null || typeof result !== "object") return null;
  const info = result as { type?: unknown; metadata?: Record<string, unknown> };
  if (info.type !== "extension") return null;
  const metadata = info.metadata ?? {};
  return {
    extensionId: stringOrNull(metadata.extensionId),
    version: stringOrNull(metadata.extensionVersion),
    profileName: stringOrNull(metadata.profileName),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Stamp a connection from inside the native host.
 *
 * Called on the way up and the way down by the process Chrome spawns, which is
 * the only witness to a connection made while the Operon app itself is closed.
 * Never throws: the host's job is to carry the protocol, and failing to write a
 * status file is not a reason to break the pipe the user is actually using.
 */
export function recordHostLifecycle(homeDir: string = os.homedir()): void {
  try {
    writeLastSeen(homeDir);
  } catch {
    // Best effort by design; see above.
  }
}

function writeLastSeen(homeDir: string): void {
  try {
    const file = lastSeenFile(homeDir);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Write-then-rename: two hosts exiting together must not leave a half-written
    // file that reads as "never connected" and undoes the whole point of this.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now() }));
    fs.renameSync(tmp, file);
  } catch {
    // A read-only home is not worth failing a status check over.
  }
}

function readLastSeen(homeDir: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lastSeenFile(homeDir), "utf8")) as { at?: unknown };
    return typeof parsed.at === "number" ? parsed.at : null;
  } catch {
    return null;
  }
}
