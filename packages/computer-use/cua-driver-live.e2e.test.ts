// @vitest-environment node
/**
 * The migration's product code against a real `cua-driver serve`.
 *
 * This suite deliberately asserts only what holds with the screen locked, so it
 * can run unattended: process lifecycle, the daemon handshake, the long-lived
 * connection, app listing, and policy. Reading an accessibility tree or
 * delivering input needs an unlocked session and belongs in the differential
 * suite instead.
 *
 * Gated on OPERON_CUA_DRIVER_BIN pointing at the binary under test.
 *
 * See docs/cua-driver-migration/design.md.
 */
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CuaDriverService } from "./CuaDriverService.ts";
import { CuaDriverBackend } from "./computer/cua/backend.ts";
import { CuaDaemonTransport } from "./computer/cua/daemon.ts";
import type { NativePipeConnection } from "./computer/wire.ts";

const CUA_BIN = process.env.OPERON_CUA_DRIVER_BIN ?? "";
const RUN = process.platform === "darwin" && CUA_BIN !== "" && fs.existsSync(CUA_BIN);
const describeLive = RUN ? describe : describe.skip;

/** node net socket in the shape the kernel's nativePipe hands us. */
function connectPipe(socketPath: string): Promise<NativePipeConnection> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    socket.once("connect", () => resolve(socket as unknown as NativePipeConnection));
    socket.once("error", reject);
  });
}

describeLive("cua-driver, live daemon", () => {
  let service: CuaDriverService | undefined;
  let backend: CuaDriverBackend | undefined;
  let stderr = "";

  beforeAll(async () => {
    service = new CuaDriverService({
      binaryPath: CUA_BIN,
      socketPath: path.join(os.homedir(), ".operon", "run", `cua-live-${process.pid}.sock`),
      cursorOverlay: false,
      onStderrLine: (line) => { stderr += `${line}\n`; },
    });
    await service.start();
    backend = new CuaDriverBackend({
      socketPath: service.socketPath,
      connect: connectPipe,
      sessionId: `operon-live-${process.pid}`,
    });
  }, 60_000);

  afterAll(async () => {
    backend?.dispose();
    await service?.stop();
  });

  it("starts the daemon and answers the metadata handshake", async () => {
    await expect(service!.isReady()).resolves.toBe(true);
    const socket = await connectPipe(service!.socketPath);
    const transport = new CuaDaemonTransport(socket);
    const meta = await transport.send({ method: "metadata" });
    expect(meta.ok).toBe(true);
    const result = meta.result as Record<string, unknown>;
    // Proof the embedding contract took: a standalone daemon reports embedded=false
    // and disclaims TCC responsibility instead of inheriting Operon's grants.
    expect(result.embedded).toBe(true);
    expect(result.host_bundle_id).toBe("top.chatcode.operon");
    expect(typeof result.driver_version).toBe("string");
    transport.end();
  }, 30_000);

  it("keeps one connection across many calls", async () => {
    const socket = await connectPipe(service!.socketPath);
    const transport = new CuaDaemonTransport(socket);
    for (let i = 0; i < 25; i++) {
      const reply = await transport.send({ method: "metadata" });
      expect(reply.ok).toBe(true);
    }
    expect(transport.isClosed).toBe(false);
    transport.end();
  }, 30_000);

  it("lists running apps through the backend", async () => {
    const apps = await backend!.listApps();
    expect(apps.length).toBeGreaterThan(0);
    const withBundle = apps.filter((app) => typeof app.bundleIdentifier === "string");
    expect(withBundle.length).toBeGreaterThan(0);
    expect(withBundle[0]).toHaveProperty("displayName");
  }, 30_000);

  it("computes policy locally, allowing Finder and forbidding the block list", async () => {
    const finder = await backend!.getAppPolicy("com.apple.finder");
    expect(finder.decision).toBe("allowed");
    expect(finder.target.bundleIdentifier).toBe("com.apple.finder");

    // Operon's own bundle id is on the block list, and the driver has no such
    // concept, so this proves the policy layer is ours and still enforced.
    const blocked = await backend!.getAppPolicy("top.chatcode.operon").catch((error: Error) => error);
    if (blocked instanceof Error) {
      // Not installed under that id on this machine; the identity check is what
      // matters and it is covered by the unit tests.
      expect(blocked.message).toMatch(/could not find/i);
    } else {
      expect(blocked.decision).toBe("forbidden");
    }
  }, 30_000);

  it("reports a refusal with the driver's own message", async () => {
    const socket = await connectPipe(service!.socketPath);
    const transport = new CuaDaemonTransport(socket);
    // window_id is required; the driver answers with a structured tool error
    // rather than a transport failure, and the client must keep them apart.
    await expect(transport.call("get_window_state", { pid: process.pid }))
      .rejects.toThrow(/window_id/i);
    expect(transport.isClosed).toBe(false);
    transport.end();
  }, 30_000);

  it("leaves no stderr noise about telemetry or updates", () => {
    expect(stderr).not.toMatch(/telemetry/i);
    expect(stderr).not.toMatch(/update available/i);
  });
});
