// @vitest-environment node
//
// Code-signature peer verification. Exercises the REAL native addon and
// REAL unix sockets on macOS — the only meaningful test for native peer resolution.
//
// The two guarantees under test on a dev (adhoc) build:
//   1. flag off  → every peer allowed, behavior unchanged.
//   2. flag on + unsigned self (no Team ID) → allow + warn, NEVER locks dev out.
// The signed-release enforce path (accept our team, reject others) can only be
// verified on a Developer ID + notarized build, so it is deliberately not asserted here.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { authorizePeer, socketFd } from "./peer-auth.ts";

const ENABLE_ENV = "OPERON_REQUIRE_SIGNED_PEER";
const isDarwin = process.platform === "darwin";

const here = fileURLToPath(new URL(".", import.meta.url)); // packages/browser-use
const addonPath = path.join(
  here,
  "..",
  "..",
  "native",
  "peer-auth",
  "build",
  "Release",
  "operon_peer_auth.node",
);
const hasAddon = fs.existsSync(addonPath);

let pairCounter = 0;

interface SocketPair {
  serverSocket: net.Socket;
  cleanup: () => void;
}

/** A real connected unix socket pair; resolves with the server-side Socket. */
function makePair(): Promise<SocketPair> {
  return new Promise((resolve, reject) => {
    const sockPath = path.join(os.tmpdir(), `operon-pa-${process.pid}-${pairCounter++}.sock`);
    try {
      fs.unlinkSync(sockPath);
    } catch {
      // not present — fine
    }
    let client: net.Socket | undefined;
    const server = net.createServer((serverSocket) => {
      resolve({
        serverSocket,
        cleanup: () => {
          serverSocket.destroy();
          client?.destroy();
          server.close();
          try {
            fs.unlinkSync(sockPath);
          } catch {
            // best effort
          }
        },
      });
    });
    server.once("error", reject);
    server.listen(sockPath, () => {
      client = net.connect(sockPath);
      client.once("error", reject);
    });
  });
}

describe.skipIf(!isDarwin)("peer-auth socket authorization", () => {
  afterEach(() => {
    delete process.env[ENABLE_ENV];
  });

  it("allows every peer when the flag is unset (behavior unchanged)", async () => {
    delete process.env[ENABLE_ENV];
    const pair = await makePair();
    try {
      expect(authorizePeer(pair.serverSocket)).toBe(true);
    } finally {
      pair.cleanup();
    }
  });

  it("does not lock out dev: flag on + unsigned (adhoc) self → allow", async () => {
    // On an adhoc dev build self has no Team ID, so the policy cannot enforce and
    // must fail open. This is the guarantee that turning the flag on in dev never
    // bricks the browser-use sockets.
    process.env[ENABLE_ENV] = "1";
    const pair = await makePair();
    try {
      expect(authorizePeer(pair.serverSocket)).toBe(true);
    } finally {
      pair.cleanup();
    }
  });

  it("fails open when the socket fd cannot be read", () => {
    process.env[ENABLE_ENV] = "1";
    const detached = new net.Socket(); // never connected → no _handle.fd
    expect(socketFd(detached)).toBeUndefined();
    expect(authorizePeer(detached)).toBe(true);
  });
});

describe.skipIf(!isDarwin || !hasAddon)("peer-auth native addon", () => {
  // Loaded lazily. `describe.skipIf` still evaluates this callback while
  // collecting, so a top-level require of a macOS-only .node file throws on
  // Linux before the skip can take effect.
  type PeerAuthAddon = {
    peerAuditIdentity(fd: number): { teamIdentifier: string | null; signingIdentifier: string | null };
    selfAuditIdentity(): { teamIdentifier: string | null; signingIdentifier: string | null };
  };
  let addon: PeerAuthAddon;
  beforeAll(() => {
    addon = createRequire(import.meta.url)(addonPath) as PeerAuthAddon;
  });

  it("reports this dev build as unsigned (no Team ID) without crashing", () => {
    const self = addon.selfAuditIdentity();
    expect(self).toHaveProperty("teamIdentifier");
    expect(self).toHaveProperty("signingIdentifier");
    expect(self.teamIdentifier).toBeNull(); // adhoc dev build
  });

  it("resolves a real peer's identity off the socket fd without throwing", async () => {
    const pair = await makePair();
    try {
      const fd = socketFd(pair.serverSocket);
      expect(fd).toBeDefined();
      const id = addon.peerAuditIdentity(fd as number);
      expect(id).toHaveProperty("teamIdentifier");
      expect(id).toHaveProperty("signingIdentifier");
      expect(id.teamIdentifier).toBeNull(); // peer is the same adhoc node binary
    } finally {
      pair.cleanup();
    }
  });

  it("returns nulls (not a throw) for a non-socket fd", () => {
    const tmp = path.join(os.tmpdir(), `operon-pa-file-${process.pid}.txt`);
    fs.writeFileSync(tmp, "x");
    const fd = fs.openSync(tmp, "r");
    try {
      const id = addon.peerAuditIdentity(fd);
      expect(id.teamIdentifier).toBeNull();
      expect(id.signingIdentifier).toBeNull();
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(tmp);
    }
  });

  it("throws on a negative fd", () => {
    expect(() => addon.peerAuditIdentity(-1)).toThrow();
  });
});
