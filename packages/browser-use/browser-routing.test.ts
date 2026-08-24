// @vitest-environment node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browsers, closeBrowser } from "./sdk/index.ts";
import { BUILD_FLAVOR_ENV, decodeFrames, encodeFrame } from "./wire.ts";

const SESSION = "ROUTING";
const FLAVOR = "operon-routing";

interface FakeBackend {
  close(): Promise<void>;
}

async function fakeBackend(options: {
  dir: string;
  id: string;
  type: "iab" | "extension";
  tabs: string[];
  flavor?: string;
}): Promise<FakeBackend> {
  const socketPath = path.join(options.dir, `${options.id}.sock`);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeFrames(buffer);
      buffer = decoded.remainingData;
      for (const raw of decoded.messages) {
        const message = JSON.parse(raw) as {
          id: number;
          method: string;
        };
        let result: unknown = null;
        if (message.method === "getInfo") {
          result = {
            id: options.id,
            name: options.id,
            type: options.type,
            capabilities: {},
            metadata: {
              operonBuildFlavor: options.flavor ?? FLAVOR,
              ...(options.type === "iab" ? { operonSessionId: SESSION } : {}),
            },
          };
        } else if (message.method === "getTabs" || message.method === "getUserTabs") {
          result = options.tabs.map((url, index) => ({
            active: index === 0,
            id: index + 1,
            title: url,
            url,
          }));
        }
        socket.write(encodeFrame(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result,
        })));
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("Browsers URL routing", () => {
  let dir: string;
  const backends: FakeBackend[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-routing-"));
    backends.push(
      await fakeBackend({
        dir,
        id: "iab-route",
        type: "iab",
        tabs: ["https://docs.example.com/guide"],
      }),
      await fakeBackend({
        dir,
        id: "extension-route",
        type: "extension",
        tabs: ["https://github.com/openai/codex#readme", "https://example.org/"],
      }),
      await fakeBackend({
        dir,
        id: "other-build-extension",
        type: "extension",
        tabs: ["https://wrong.example/"],
        flavor: "other-operon-build",
      }),
      await fakeBackend({
        dir,
        id: "other-build-iab",
        type: "iab",
        tabs: ["https://wrong-iab.example/"],
        flavor: "other-operon-build",
      }),
    );
    (globalThis as Record<string, unknown>).nodeRepl = {
      nativePipe: {
        createConnection: (socketPath: string) =>
          new Promise<net.Socket>((resolve, reject) => {
            const socket = net.createConnection(socketPath);
            socket.once("connect", () => resolve(socket));
            socket.once("error", reject);
          }),
      },
      requestMeta: {
        "x-codex-turn-metadata": { session_id: SESSION, turn_id: "T1" },
      },
      env: { [BUILD_FLAVOR_ENV]: FLAVOR },
    };
  });

  afterAll(async () => {
    await Promise.all(backends.map((backend) => backend.close()));
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it("applies build flavor only to IAB backends", async () => {
    const infos = await new Browsers(dir).list();
    const ids = infos.map((info) => info.id);
    expect(ids).toContain("other-build-extension");
    expect(ids).not.toContain("other-build-iab");
  });

  it("uses IAB for localhost even when Chrome has unrelated open tabs", async () => {
    const browser = await new Browsers(dir).getForUrl("http://localhost:5173/");
    expect(browser.browserId).toBe("iab-route");
    closeBrowser(browser);
  });

  it("uses Chrome when its existing tab exactly matches after hash removal", async () => {
    const browser = await new Browsers(dir).getForUrl("https://github.com/openai/codex");
    expect(browser.browserId).toBe("extension-route");
    closeBrowser(browser);
  });

  it("matches hostname hierarchy before falling back", async () => {
    const browser = await new Browsers(dir).getForUrl("https://api.example.org/v1");
    expect(browser.browserId).toBe("extension-route");
    closeBrowser(browser);
  });

  it("prefers IAB when no open tab matches", async () => {
    const browser = await new Browsers(dir).getForUrl("https://unmatched.invalid/");
    expect(browser.browserId).toBe("iab-route");
    closeBrowser(browser);
  });

  it("accepts the current explicit Chrome client type", async () => {
    const browser = await new Browsers(dir).get("extension");
    expect(browser.browserId).toBe("extension-route");
    closeBrowser(browser);
  });
});
