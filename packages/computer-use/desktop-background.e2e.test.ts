// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const RUN_DESKTOP_SMOKE =
  process.platform === "darwin"
  && process.env.OPERON_RUN_COMPUTER_USE_DESKTOP_SMOKE === "1";
const describeDesktopSmoke = RUN_DESKTOP_SMOKE ? describe : describe.skip;
const API_VERSION = "CodexComputerUseIPC-2";
const TARGET_APP_PATH = "/System/Applications/System Settings.app";
const TARGET_BUNDLE_IDENTIFIER = "com.apple.systempreferences";
const SWIFT_BIN = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "../../native/computer-use/.build/debug/operon-computer-use",
);

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function currentFrontmostBundleIdentifier(): string {
  const asn = execFileSync("/usr/bin/lsappinfo", ["front"], { encoding: "utf8" }).trim();
  const info = execFileSync(
    "/usr/bin/lsappinfo",
    ["info", "-only", "bundleID", asn],
    { encoding: "utf8" },
  );
  const match = /"CFBundleIdentifier"="([^"]+)"/.exec(info);
  if (!match) throw new Error(`Could not resolve frontmost app from: ${info}`);
  return match[1];
}

function targetIsRunning(): boolean {
  const result = spawnSync(
    "/usr/bin/pgrep",
    ["-f", "/System Settings.app/Contents/MacOS/System Settings$"],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

async function waitForSocket(socketPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Computer Use socket did not appear: ${socketPath}`);
}

async function sendRequest(
  socketPath: string,
  message: unknown,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Computer Use desktop smoke request timed out"));
    }, 20_000);

    socket.once("connect", () => socket.write(encodeFrame(message)));
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      clearTimeout(timer);
      socket.end();
      resolve(JSON.parse(buffer.subarray(4, length + 4).toString("utf8")));
    });
  });
}

describeDesktopSmoke("Computer Use macOS background behavior", () => {
  let tempDirectory = "";
  let socketPath = "";
  let service: ChildProcess | undefined;
  let serviceStderr = "";
  let serviceStdout = "";
  const presentationEvents: Array<Record<string, unknown>> = [];
  let targetWasRunning = false;
  let frontmostBefore = "";

  beforeAll(async () => {
    if (!fs.existsSync(SWIFT_BIN)) {
      throw new Error(`Build the Swift service before running this smoke test: ${SWIFT_BIN}`);
    }

    targetWasRunning = targetIsRunning();
    frontmostBefore = currentFrontmostBundleIdentifier();
    if (frontmostBefore === TARGET_BUNDLE_IDENTIFIER) {
      throw new Error("System Settings must not be frontmost before the desktop smoke test");
    }

    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "operon-cu-background-"));
    socketPath = path.join(tempDirectory, "computer-use.sock");
    service = spawn(SWIFT_BIN, [socketPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPERON_CU_PRESENTATION_EVENTS: "1",
      },
    });
    service.stdout?.setEncoding("utf8");
    service.stdout?.on("data", (chunk: string | Buffer) => {
      serviceStdout += String(chunk);
      for (;;) {
        const newline = serviceStdout.indexOf("\n");
        if (newline < 0) break;
        const line = serviceStdout.slice(0, newline);
        serviceStdout = serviceStdout.slice(newline + 1);
        try {
          presentationEvents.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // The assertion below reports missing events with stderr context.
        }
      }
    });
    service.stderr?.on("data", (chunk) => {
      serviceStderr += String(chunk);
    });
    await waitForSocket(socketPath);
  });

  afterAll(() => {
    service?.kill("SIGTERM");
    if (!targetWasRunning) {
      spawnSync(
        "/usr/bin/pkill",
        ["-f", "/System Settings.app/Contents/MacOS/System Settings$"],
        { stdio: "ignore" },
      );
    }
    if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("launches and snapshots System Settings without changing the user's foreground app", async () => {
    const response = await sendRequest(socketPath, {
      jsonrpc: "2.0",
      id: 1,
      method: "request",
      params: {
        clientApiVersion: API_VERSION,
        codexTurnMetadata: {
          session_id: "desktop-background-smoke",
          turn_id: "turn-1",
          operon_session_id: "desktop-background-smoke",
        },
        deadlineUnixMilliseconds: Date.now() + 20_000,
        requestType: "ComputerUseIPCAppGetSkyshotRequest",
        request: {
          app: TARGET_APP_PATH,
          disableDiff: true,
        },
      },
    });

    expect(
      response.error,
      `Computer Use request failed: ${response.error?.message}\n${serviceStderr}`,
    ).toBeUndefined();
    expect(response.result).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(currentFrontmostBundleIdentifier()).toBe(frontmostBefore);

    const presentationDeadline = Date.now() + 5_000;
    while (
      Date.now() < presentationDeadline
      && !presentationEvents.some((event) => event.type === "presentation")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      presentationEvents.some((event) => event.type === "active"),
      serviceStderr,
    ).toBe(true);
    expect(
      presentationEvents.some(
        (event) => event.type === "presentation"
          && typeof event.contextID === "number"
          && typeof event.width === "number"
          && typeof event.height === "number",
      ),
      `${serviceStderr}\n${JSON.stringify(presentationEvents)}`,
    ).toBe(true);

    const ended = await sendRequest(socketPath, {
      jsonrpc: "2.0",
      id: 2,
      method: "operon/session-ended",
      params: { hostSessionID: "desktop-background-smoke" },
    });
    expect(ended.error).toBeUndefined();

    const endedDeadline = Date.now() + 2_000;
    while (
      Date.now() < endedDeadline
      && !presentationEvents.some((event) => event.type === "ended")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(presentationEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "ended",
          hostSessionID: "desktop-background-smoke",
          reason: "turn-ended",
        }),
      ]),
    );
  }, 30_000);
});
