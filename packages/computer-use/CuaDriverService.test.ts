import { createConnection } from "node:net";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuaDriverService } from "./CuaDriverService.ts";

const services: CuaDriverService[] = [];
const tempDirs: string[] = [];

/**
 * Stands in for `cua-driver serve`. It records the environment it was given so
 * the test can assert the embedding contract, binds the socket, and exits on
 * command so restart behaviour is observable.
 */
const FAKE_DRIVER = `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
const socketPath = args[args.indexOf("--socket") + 1];
fs.writeFileSync(process.env.FAKE_DRIVER_REPORT, JSON.stringify({
  argv: args,
  env: {
    CUA_DRIVER_EMBEDDED: process.env.CUA_DRIVER_EMBEDDED ?? null,
    CUA_DRIVER_HOST_BUNDLE_ID: process.env.CUA_DRIVER_HOST_BUNDLE_ID ?? null,
    CUA_DRIVER_PERMISSION_MODE: process.env.CUA_DRIVER_PERMISSION_MODE ?? null,
    CUA_DRIVER_RS_UPDATE_CHECK: process.env.CUA_DRIVER_RS_UPDATE_CHECK ?? null,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED ?? null,
  },
  stdinIsPipe: !process.stdin.isTTY,
}));
try { fs.rmSync(socketPath, { force: true }); } catch {}
const server = net.createServer((socket) => {
  socket.on("data", (d) => { if (d.toString().includes("crash")) process.exit(42); });
});
if (process.env.FAKE_DRIVER_DELAY_MS) {
  setTimeout(() => server.listen(socketPath), Number(process.env.FAKE_DRIVER_DELAY_MS));
} else {
  server.listen(socketPath);
}
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`;

async function makeService(options: Partial<{ delayMs: number; restartDelaysMs: number[] }> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cua-driver-service-"));
  tempDirs.push(dir);
  const binaryPath = path.join(dir, "fake-cua-driver");
  await writeFile(binaryPath, FAKE_DRIVER, "utf8");
  await chmod(binaryPath, 0o755);
  const reportPath = path.join(dir, "report.json");
  // Short by design: sun_path caps near 104 bytes and the macOS temp dir is long.
  const socketPath = path.join(os.homedir(), ".operon", "run", `cua-test-${process.pid}-${services.length}.sock`);
  process.env.FAKE_DRIVER_REPORT = reportPath;
  if (options.delayMs != null) process.env.FAKE_DRIVER_DELAY_MS = String(options.delayMs);
  else delete process.env.FAKE_DRIVER_DELAY_MS;
  const service = new CuaDriverService({
    binaryPath,
    socketPath,
    hostBundleId: "top.chatcode.operon",
    restartDelaysMs: options.restartDelaysMs,
  });
  services.push(service);
  return { service, reportPath, socketPath };
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("CuaDriverService", () => {
  it("declares the embedding contract the OS responsibility chain depends on", async () => {
    const { service, reportPath } = await makeService();
    await service.start();
    const report = JSON.parse(await readFile(reportPath, "utf8"));

    // Only the exact value "1" turns embedded mode on, and without it the daemon
    // disclaims responsibility and stops inheriting Operon's TCC grants.
    expect(report.env.CUA_DRIVER_EMBEDDED).toBe("1");
    expect(report.argv).toContain("--embedded");
    expect(report.env.CUA_DRIVER_HOST_BUNDLE_ID).toBe("top.chatcode.operon");
    expect(report.env.CUA_DRIVER_PERMISSION_MODE).toBe("standard");
  });

  it("switches off the driver's own telemetry and update check", async () => {
    const { service, reportPath } = await makeService();
    await service.start();
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    // The daemon phones home and self-updates by default. Neither belongs in a
    // binary Operon ships inside its own bundle.
    expect(report.env.CUA_DRIVER_RS_TELEMETRY_ENABLED).toBe("0");
    expect(report.env.CUA_DRIVER_RS_UPDATE_CHECK).toBe("0");
  });

  it("keeps stdin open as the daemon's liveness signal", async () => {
    const { service, reportPath } = await makeService();
    await service.start();
    expect(JSON.parse(await readFile(reportPath, "utf8")).stdinIsPipe).toBe(true);
  });

  it("waits for a real listener rather than for the socket file to appear", async () => {
    const { service, socketPath } = await makeService({ delayMs: 400 });
    const started = Date.now();
    await service.start();
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    await expect(service.isReady()).resolves.toBe(true);
    expect(existsSync(socketPath)).toBe(true);
  });

  it("removes a stale socket left by a previous run before binding", async () => {
    const { service, socketPath } = await makeService();
    await writeFile(socketPath, "not a socket", "utf8").catch(() => {});
    await service.start();
    await expect(service.isReady()).resolves.toBe(true);
  });

  it("restarts after the daemon dies, when restart delays are configured", async () => {
    const { service, socketPath } = await makeService({ restartDelaysMs: [50] });
    await service.start();
    const firstPid = (service as unknown as { proc?: { pid?: number } }).proc?.pid;

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once("connect", () => { socket.write("crash"); socket.end(); resolve(); });
      socket.once("error", reject);
    });

    // The dead daemon's socket file outlives it for a moment, so readiness alone
    // would pass against the corpse. Wait for a genuinely different process.
    const pid = () => (service as unknown as { proc?: { pid?: number } }).proc?.pid;
    const deadline = Date.now() + 5_000;
    for (;;) {
      if (pid() != null && pid() !== firstPid && (await service.isReady())) break;
      if (Date.now() > deadline) throw new Error("daemon did not come back");
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(pid()).not.toBe(firstPid);
  });

  it("reports a missing binary as a clear install problem", async () => {
    const service = new CuaDriverService({
      binaryPath: "/nonexistent/cua-driver",
      socketPath: path.join(os.homedir(), ".operon", "run", `cua-missing-${process.pid}.sock`),
    });
    services.push(service);
    await expect(service.start()).rejects.toThrow(/not installed/);
  });
});
