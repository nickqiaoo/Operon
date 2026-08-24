import { createConnection } from "node:net";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerUseService, type ComputerUseServiceExit } from "./ComputerUseService.ts";

const services: ComputerUseService[] = [];
const tempDirs: string[] = [];

const FIXTURE_SERVER = `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const socketPath = process.argv[2];
try { fs.rmSync(socketPath, { force: true }); } catch {}
const server = net.createServer((socket) => {
  let buf = Buffer.alloc(0);
  socket.on("data", (data) => {
    // Raw string control commands, sent directly by the test with no framing.
    const command = data.toString();
    if (command === "crash") process.exit(42);
    if (command === "unlisten") { server.close(); return; }
    // Everything else is buffered as [4-byte LE length][JSON] and handled frame by
    // frame, since several can arrive at once.
    buf = Buffer.concat([buf, data]);
    while (buf.length >= 4) {
      const length = buf.readUInt32LE(0);
      if (buf.length < length + 4) break;
      const request = JSON.parse(buf.subarray(4, length + 4).toString("utf8"));
      buf = buf.subarray(length + 4);
      // The authentication frame is consumed silently, mirroring the real Swift
      // engine: no reply, no routing.
      if (request.method === "operon/authenticate") continue;
      if (
        request.method !== "operon/session-ended"
        || request.params?.hostSessionID !== "chat-42"
        || process.env.OPERON_CU_PRESENTATION_EVENTS !== "1"
      ) continue;
      const payload = Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { ended: true },
      }));
      const frame = Buffer.allocUnsafe(payload.length + 4);
      frame.writeUInt32LE(payload.length, 0);
      payload.copy(frame, 4);
      socket.write(frame);
    }
  });
});
if (process.env.OPERON_CU_PRESENTATION_EVENTS === "1") {
  process.stdout.write(JSON.stringify({
    type: "active",
    hostSessionID: "chat-42",
    displayName: "System Settings",
  }) + "\\n");
}
server.listen(socketPath);
setInterval(() => {}, 1000);
`;

async function fixture(): Promise<{ binaryPath: string; socketPath: string }> {
  const dir = await mkdtemp("/tmp/opcu-service-test-");
  tempDirs.push(dir);
  const binaryPath = path.join(dir, "fixture.cjs");
  const socketPath = path.join(dir, "service.sock");
  await writeFile(binaryPath, FIXTURE_SERVER);
  await chmod(binaryPath, 0o755);
  return { binaryPath, socketPath };
}

function send(socketPath: string, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.end(command, resolve);
    });
    socket.once("error", reject);
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met before timeout");
}

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.stop()));
  await Promise.allSettled(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ComputerUseService", () => {
  it("waits for a real listener and removes a stale socket before starting", async () => {
    const { binaryPath, socketPath } = await fixture();
    await writeFile(socketPath, "stale");
    const service = new ComputerUseService({ binaryPath, socketPath });
    services.push(service);

    await service.start();

    expect(service.running).toBe(true);
    await expect(service.isReady()).resolves.toBe(true);
  });

  it("restarts after either a process crash or a live process loses its listener", async () => {
    const exits: ComputerUseServiceExit[] = [];
    const { binaryPath, socketPath } = await fixture();
    const service = new ComputerUseService({
      binaryPath,
      socketPath,
      onExit: (exit) => exits.push(exit),
    });
    services.push(service);

    await service.start();
    await send(socketPath, "crash");
    await waitUntil(() => !service.running);
    expect(exits).toMatchObject([{ code: 42 }]);

    await service.start();
    await expect(service.isReady()).resolves.toBe(true);

    await send(socketPath, "unlisten");
    await waitUntil(async () => !(await service.isReady()));
    expect(service.running).toBe(true);

    await service.start();
    expect(service.running).toBe(true);
    await expect(service.isReady()).resolves.toBe(true);
  });

  it("automatically restarts an unexpectedly exited service with bounded backoff", async () => {
    const exits: ComputerUseServiceExit[] = [];
    const { binaryPath, socketPath } = await fixture();
    const service = new ComputerUseService({
      binaryPath,
      socketPath,
      restartDelaysMs: [10, 25, 50],
      onExit: (exit) => exits.push(exit),
    });
    services.push(service);

    await service.start();
    await send(socketPath, "crash");
    await waitUntil(() => exits.length === 1);
    await waitUntil(async () => service.running && await service.isReady(), 3000);

    expect(exits).toMatchObject([{ code: 42 }]);
    await expect(service.isReady()).resolves.toBe(true);
  });

  it("forwards presentation events and sends the host session-end control frame", async () => {
    const events: Array<{ type: string; hostSessionID?: string }> = [];
    const { binaryPath, socketPath } = await fixture();
    const service = new ComputerUseService({
      binaryPath,
      socketPath,
      onPresentationEvent: (event) => events.push(event),
    });
    services.push(service);

    await service.start();
    await waitUntil(() => events.some((event) => event.type === "active"));
    await expect(service.endHostSession("chat-42")).resolves.toBeUndefined();

    expect(events).toContainEqual(expect.objectContaining({
      type: "active",
      hostSessionID: "chat-42",
    }));
  });
});
