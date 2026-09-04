import fs from "node:fs";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFrames, encodeFrame } from "./wire.ts";
import {
  presenceDir,
  readChromePresence,
  recordHostLifecycle,
} from "./chrome-host-presence.ts";

const tempDirs: string[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((res) => s.close(() => res()))),
  );
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Point the module at a throwaway socket directory.
 *
 * `/tmp/operon-browser-use` is shared with whatever the developer has running, so
 * a test reading the real one would see their live Chrome and pass for the wrong
 * reason.
 */
async function fakeSocketDir(): Promise<string> {
  const dir = await tempDir("operon-presence-sockets-");
  const wire = await import("./wire.ts");
  vi.spyOn(wire, "backendSocketDir").mockReturnValue(dir);
  return dir;
}

/** A backend that answers `getInfo` with whatever info it is given. */
async function fakeBackend(
  dir: string,
  name: string,
  info: Record<string, unknown> | null,
): Promise<void> {
  const server = net.createServer((socket) => {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { messages, remainingData } = decodeFrames(buffer);
      buffer = remainingData;
      for (const message of messages) {
        const request = JSON.parse(message) as { id: number; method: string };
        if (request.method !== "getInfo" || info === null) continue; // Silent backend.
        socket.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: info })));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(path.join(dir, name), () => res()));
}

const extensionInfo = (metadata: Record<string, string> = {}) => ({
  id: "abc",
  name: "Operon Chrome",
  type: "extension",
  capabilities: {},
  metadata: { extensionId: "annipikgonognboogflchfnagmhbbipc", ...metadata },
});

describe("chrome presence", () => {
  /**
   * The whole point: Chrome starts the native host only when the extension calls
   * connectNative(), so an answer here proves installed + enabled + reachable —
   * something the profile registry cannot establish at any price, and this costs
   * no privacy grant.
   */
  it("reports connected when the extension answers getInfo", async () => {
    const dir = await fakeSocketDir();
    const home = await tempDir("operon-presence-home-");
    await fakeBackend(dir, "chrome.sock", extensionInfo({ extensionVersion: "1.4.0" }));

    const presence = await readChromePresence(home);

    expect(presence.connected).toBe(true);
    expect(presence.extensions).toEqual([
      {
        extensionId: "annipikgonognboogflchfnagmhbbipc",
        version: "1.4.0",
        profileName: null,
      },
    ]);
  });

  /**
   * The socket directory is shared with Operon's own in-app browser, and only
   * `type` tells them apart. Counting an IAB backend as the Chrome extension would
   * turn the row green on every machine, including ones with no extension at all.
   */
  it("ignores Operon's own in-app browser on the same directory", async () => {
    const dir = await fakeSocketDir();
    const home = await tempDir("operon-presence-home-");
    await fakeBackend(dir, "iab.sock", { id: "x", name: "Operon", type: "iab", capabilities: {} });

    expect(await readChromePresence(home)).toMatchObject({ connected: false, extensions: [] });
  });

  it("counts one connection per Chrome profile", async () => {
    const dir = await fakeSocketDir();
    const home = await tempDir("operon-presence-home-");
    await fakeBackend(dir, "a.sock", extensionInfo({ profileName: "Default" }));
    await fakeBackend(dir, "b.sock", extensionInfo({ profileName: "Profile 1" }));

    const presence = await readChromePresence(home);

    expect(presence.extensions.map((e) => e.profileName).sort()).toEqual(["Default", "Profile 1"]);
  });

  /** Sockets outlive the processes that made them; a leftover must not read as connected. */
  it("ignores a socket file with nothing listening", async () => {
    const dir = await fakeSocketDir();
    const home = await tempDir("operon-presence-home-");
    fs.writeFileSync(path.join(dir, "stale.sock"), "");

    expect(await readChromePresence(home)).toMatchObject({ connected: false });
  });

  /** A wedged backend must not hold the settings page open. */
  it("gives up on a backend that connects but never answers", async () => {
    const dir = await fakeSocketDir();
    const home = await tempDir("operon-presence-home-");
    await fakeBackend(dir, "silent.sock", null);

    const presence = await readChromePresence(home);

    expect(presence.connected).toBe(false);
  }, 10_000);

  it("reports never-connected as null rather than a zero timestamp", async () => {
    await fakeSocketDir();
    const home = await tempDir("operon-presence-home-");

    expect(await readChromePresence(home)).toEqual({
      connected: false,
      extensions: [],
      lastSeenAt: null,
    });
  });

  /**
   * The half that survives Chrome being closed. Absence alone proves nothing, so
   * "connected two minutes ago" and "never connected" have to be distinguishable —
   * only the second is evidence the extension is missing.
   */
  it("remembers a past connection once the extension is gone", async () => {
    const dir = await fakeSocketDir();
    const home = await tempDir("operon-presence-home-");
    await fakeBackend(dir, "chrome.sock", extensionInfo());

    await readChromePresence(home); // Observes it, and stamps last-seen.
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    fs.rmSync(path.join(dir, "chrome.sock"), { force: true });

    const presence = await readChromePresence(home);

    expect(presence.connected).toBe(false);
    expect(presence.lastSeenAt).toBeGreaterThan(0);
  });

  /**
   * Stamping from inside the host covers connections made while the Operon app is
   * closed, which is the one window `readChromePresence` can never observe.
   */
  it("records a connection stamped by the host itself", async () => {
    await fakeSocketDir();
    const home = await tempDir("operon-presence-home-");

    recordHostLifecycle(home);

    expect((await readChromePresence(home)).lastSeenAt).toBeGreaterThan(0);
  });

  /** The host must never fail on account of its own bookkeeping. */
  it("survives an unwritable presence directory", async () => {
    const home = await tempDir("operon-presence-home-");
    fs.mkdirSync(presenceDir(home), { recursive: true });
    fs.chmodSync(presenceDir(home), 0o500);
    try {
      expect(() => recordHostLifecycle(home)).not.toThrow();
    } finally {
      fs.chmodSync(presenceDir(home), 0o700);
    }
  });
});
