// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const RUN_ELECTRON_SMOKE =
  process.platform === "darwin"
  && process.env.OPERON_RUN_COMPUTER_USE_ELECTRON_SMOKE === "1";
const describeElectronSmoke = RUN_ELECTRON_SMOKE ? describe : describe.skip;
const API_VERSION = "CodexComputerUseIPC-2";
const TARGET_APP_PATH =
  process.env.OPERON_COMPUTER_USE_ELECTRON_APP_PATH ?? "/Applications/QQ.app";
const TARGET_BUNDLE_IDENTIFIER =
  process.env.OPERON_COMPUTER_USE_ELECTRON_BUNDLE_ID ?? "com.tencent.qq";
const SWIFT_BIN = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "../../native/computer-use/.build/debug/operon-computer-use",
);

interface RPCError {
  code: number;
  message: string;
}

interface SkyshotResult {
  app: string;
  skyshot: {
    text: string;
    screenshot?: { url: string };
  };
}

interface RPCResponse {
  result?: unknown;
  error?: RPCError;
}

function hasHydratedRightPane(text: string): boolean {
  if (/消息列表|Rich Text Editor|文本输入区/i.test(text)) {
    return true;
  }

  // QQ's group-helper view has a second conversation list in the right pane.
  // The sparse renderer tree exposes only the left sidebar's conversation list.
  return (text.match(/会话列表/g) ?? []).length >= 2;
}

function firstConversationElementIndex(text: string): number | undefined {
  const lines = text.split("\n");
  const listLineIndex = lines.findIndex((line) => /container 会话列表/.test(line));
  if (listLineIndex < 0) return undefined;

  const listIndent = lines[listLineIndex].match(/^\t*/)?.[0].length ?? 0;
  for (const line of lines.slice(listLineIndex + 1)) {
    const indent = line.match(/^\t*/)?.[0].length ?? 0;
    if (indent <= listIndent) break;
    if (indent !== listIndent + 1) continue;

    const match = /^\t*(\d+) container(?:\s|$)/.exec(line);
    if (match) return Number(match[1]);
  }

  return undefined;
}

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function currentFrontmostBundleIdentifier(): string {
  const asn = execFileSync("/usr/bin/lsappinfo", ["front"], {
    encoding: "utf8",
  }).trim();
  const info = execFileSync(
    "/usr/bin/lsappinfo",
    ["info", "-only", "bundleID", asn],
    { encoding: "utf8" },
  );
  const match = /"CFBundleIdentifier"="([^"]+)"/.exec(info);
  if (!match) throw new Error(`Could not resolve frontmost app from: ${info}`);
  return match[1];
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
): Promise<RPCResponse> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Computer Use Electron smoke request timed out"));
    }, 30_000);

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

function requestEnvelope(
  id: number,
  requestType: string,
  request: unknown,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "request",
    params: {
      clientApiVersion: API_VERSION,
      codexTurnMetadata: {
        session_id: "desktop-electron-smoke",
        turn_id: "turn-1",
        operon_session_id: "desktop-electron-smoke",
      },
      deadlineUnixMilliseconds: Date.now() + 30_000,
      requestType,
      request,
    },
  };
}

describeElectronSmoke("Computer Use Electron background parity", () => {
  let tempDirectory = "";
  let socketPath = "";
  let service: ChildProcess | undefined;
  let serviceStderr = "";
  let frontmostBefore = "";

  beforeAll(async () => {
    if (!fs.existsSync(SWIFT_BIN)) {
      throw new Error(`Build the Swift service before running this smoke test: ${SWIFT_BIN}`);
    }
    if (!fs.existsSync(TARGET_APP_PATH)) {
      throw new Error(`Electron smoke target does not exist: ${TARGET_APP_PATH}`);
    }

    frontmostBefore = currentFrontmostBundleIdentifier();
    if (frontmostBefore === TARGET_BUNDLE_IDENTIFIER) {
      throw new Error("The Electron target must not be frontmost before the smoke test");
    }

    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "operon-cu-electron-"));
    socketPath = path.join(tempDirectory, "computer-use.sock");
    service = spawn(SWIFT_BIN, [socketPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    service.stderr?.on("data", (chunk) => {
      serviceStderr += String(chunk);
    });
    await waitForSocket(socketPath);
  });

  afterAll(() => {
    service?.kill("SIGTERM");
    if (tempDirectory) {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("hydrates the selected conversation without stealing foreground focus", async () => {
    const stateResponse = await sendRequest(
      socketPath,
      requestEnvelope(1, "ComputerUseIPCAppGetSkyshotRequest", {
        app: TARGET_APP_PATH,
        disableDiff: true,
      }),
    );
    expect(
      stateResponse.error,
      `State request failed: ${stateResponse.error?.message}\n${serviceStderr}`,
    ).toBeUndefined();

    const state = stateResponse.result as SkyshotResult;
    expect(state.skyshot.text).toMatch(/AXWebArea|HTML 内容|HTML content/i);
    expect(currentFrontmostBundleIdentifier()).toBe(frontmostBefore);

    const conversationIndex = firstConversationElementIndex(state.skyshot.text);
    expect(
      conversationIndex,
      `Could not find a QQ conversation in:\n${state.skyshot.text}`,
    ).toBeDefined();

    const actionResponse = await sendRequest(
      socketPath,
      requestEnvelope(2, "ComputerUseIPCAppPerformActionRequest", {
        app: TARGET_APP_PATH,
        action: {
          click: {
            at: { elementID: { _0: String(conversationIndex) } },
            clickCount: 1,
            mouseButton: 0,
          },
        },
      }),
    );
    expect(
      actionResponse.error,
      `Action request failed: ${actionResponse.error?.message}\n${serviceStderr}`,
    ).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(currentFrontmostBundleIdentifier()).toBe(frontmostBefore);

    const refreshedResponse = await sendRequest(
      socketPath,
      requestEnvelope(3, "ComputerUseIPCAppGetSkyshotRequest", {
        app: TARGET_APP_PATH,
        disableDiff: true,
      }),
    );
    expect(
      refreshedResponse.error,
      `Refreshed state failed: ${refreshedResponse.error?.message}\n${serviceStderr}`,
    ).toBeUndefined();
    const refreshedState = refreshedResponse.result as SkyshotResult;
    expect(refreshedState.skyshot.text).toMatch(
      /AXWebArea|HTML 内容|HTML content/i,
    );
    expect(
      hasHydratedRightPane(refreshedState.skyshot.text),
      `QQ did not publish the selected conversation subtree:\n${refreshedState.skyshot.text}\n${serviceStderr}`,
    ).toBe(true);
  }, 60_000);
});
