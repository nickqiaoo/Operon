// @vitest-environment node
/**
 * Differential harness for the cua-driver migration.
 *
 * Runs the Swift engine and the cua-driver daemon side by side against the same
 * live Electron fixture, in one process, and compares what each one sees. The
 * project has done this before: the current `computer/` client replaced a
 * proprietary one only after both were driven through the same call sequence
 * with zero divergence. Same idea here, one layer down.
 *
 * Gated on two env vars so it never runs by accident:
 *   OPERON_RUN_COMPUTER_USE_FIXTURE_E2E=1   the fixture gate the other suites use
 *   OPERON_CUA_DRIVER_BIN=<path>            the cua-driver binary under test
 *
 * See docs/cua-driver-migration/design.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeReplHost } from "./NodeReplHost.ts";

const CUA_BIN = process.env.OPERON_CUA_DRIVER_BIN ?? "";
const RUN =
  process.platform === "darwin"
  && process.env.OPERON_RUN_COMPUTER_USE_FIXTURE_E2E === "1"
  && CUA_BIN !== ""
  && fs.existsSync(CUA_BIN);
const describeDiff = RUN ? describe : describe.skip;

const FIXTURE_CTX = "diff";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SWIFT_PACKAGE = path.join(REPO_ROOT, "native/computer-use");
const SERVICE_BIN = path.join(SWIFT_PACKAGE, ".build/debug/operon-computer-use");
const ELECTRON_TEMPLATE_APP = path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
const FIXTURE_DIRECTORY = path.join(REPO_ROOT, "packages/computer-use/fixtures/electron");
const ELECTRON_BUNDLE_ID = "dev.operon.cua-e2e.diff";
const ELECTRON_DISPLAY_NAME = "Operon CUA Diff Fixture";

interface DaemonResponse { ok: boolean; result?: unknown; error?: string }

/** Line-delimited JSON client for `cua-driver serve`. One long-lived connection,
 *  which is what the migration will ship: their own Rust client opens a fresh
 *  connection per request, but the daemon loops on lines within a connection. */
class CuaDaemonClient {
  private socket: net.Socket | undefined;
  private buffer = "";
  private readonly pending: Array<(value: DaemonResponse) => void> = [];

  async connect(socketPath: string): Promise<void> {
    const socket = net.connect({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const resolve = this.pending.shift();
        if (resolve) resolve(JSON.parse(line) as DaemonResponse);
      }
    });
    this.socket = socket;
  }

  send(request: Record<string, unknown>): Promise<DaemonResponse> {
    const socket = this.socket;
    if (!socket) throw new Error("cua daemon client is not connected");
    return new Promise((resolve) => {
      this.pending.push(resolve);
      socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  call(name: string, args: Record<string, unknown> = {}): Promise<DaemonResponse> {
    return this.send({ method: "call", name, args });
  }

  end(): void {
    this.socket?.end();
  }
}

function createFixtureApp(tempDirectory: string): string {
  const appPath = path.join(tempDirectory, `${ELECTRON_DISPLAY_NAME}.app`);
  execFileSync("/bin/cp", ["-cR", ELECTRON_TEMPLATE_APP, appPath], { stdio: "ignore" });
  const plist = path.join(appPath, "Contents/Info.plist");
  for (const [key, value] of [
    ["CFBundleIdentifier", ELECTRON_BUNDLE_ID],
    ["CFBundleName", ELECTRON_DISPLAY_NAME],
    ["CFBundleDisplayName", ELECTRON_DISPLAY_NAME],
  ]) {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist], { stdio: "ignore" });
  }
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "ignore" });
  return appPath;
}

async function waitFor<T>(read: () => T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describeDiff("Swift engine and cua-driver see the same fixture", () => {
  let tempDirectory = "";
  let statePath = "";
  let appPath = "";
  let electron: ChildProcess | undefined;
  let swiftService: ChildProcess | undefined;
  let cuaDaemon: ChildProcess | undefined;
  let host: NodeReplHost | undefined;
  let cua: CuaDaemonClient | undefined;
  let cuaStderr = "";

  beforeAll(async () => {
    execFileSync("/usr/bin/swift", ["build", "--product", "operon-computer-use"], {
      cwd: SWIFT_PACKAGE,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      execFileSync("/usr/bin/pkill", ["-f", ELECTRON_DISPLAY_NAME], { stdio: "ignore" });
    } catch { /* nothing matched, the normal case */ }

    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "operon-cua-diff-"));
    appPath = createFixtureApp(tempDirectory);
    statePath = path.join(tempDirectory, "fixture-state.json");
    electron = spawn(
      path.join(appPath, "Contents/MacOS/Electron"),
      [
        FIXTURE_DIRECTORY,
        `--state-file=${statePath}`,
        `--user-data-dir=${path.join(tempDirectory, "user-data")}`,
        "--no-first-run",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    await waitFor(() => (fs.existsSync(statePath) ? true : undefined), "fixture readiness", 25_000);

    // Swift engine, driven exactly the way the other suites drive it.
    const swiftSocket = path.join(tempDirectory, "cu.sock");
    const servicePath = path.join(tempDirectory, "operon-computer-use");
    fs.copyFileSync(SERVICE_BIN, servicePath);
    fs.chmodSync(servicePath, 0o755);
    swiftService = spawn(servicePath, [swiftSocket], { stdio: ["ignore", "ignore", "pipe"] });
    await waitFor(() => (fs.existsSync(swiftSocket) ? true : undefined), "Swift socket");
    host = new NodeReplHost({
      cwd: REPO_ROOT,
      env: { SKY_CUA_NATIVE_PIPE_PATH: swiftSocket },
      tmpDir: tempDirectory,
    });
    await host.createContext(FIXTURE_CTX);

    // cua-driver daemon, embedded so it inherits this process's TCC chain.
    // The socket goes under ~/.operon/run: sun_path caps near 104 bytes and the
    // macOS temp dir is already too long for it.
    const runDir = path.join(os.homedir(), ".operon/run");
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const cuaSocket = path.join(runDir, "cua-diff.sock");
    try { fs.unlinkSync(cuaSocket); } catch { /* not there yet */ }
    cuaDaemon = spawn(CUA_BIN, ["serve", "--embedded", "--socket", cuaSocket, "--no-overlay"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_HOST_BUNDLE_ID: "dev.operon.app",
        CUA_DRIVER_RS_UPDATE_CHECK: "0",
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
      },
    });
    cuaDaemon.stderr?.on("data", (chunk: Buffer) => { cuaStderr += String(chunk); });
    await waitFor(() => (fs.existsSync(cuaSocket) ? true : undefined), `cua socket (${cuaStderr})`, 25_000);
    cua = new CuaDaemonClient();
    await cua.connect(cuaSocket);
  }, 120_000);

  afterAll(async () => {
    cua?.end();
    await host?.dispose();
    swiftService?.kill("SIGTERM");
    cuaDaemon?.kill("SIGTERM");
    electron?.kill("SIGTERM");
    if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("both engines resolve the fixture window and read a non-empty tree", async () => {
    const swiftState = await host!.exec(
      FIXTURE_CTX,
      `return await computer.get_app_state({ app: ${JSON.stringify(appPath)}, disableDiff: true });`,
    ) as { text: string };
    const swiftIndexed = (swiftState.text.match(/^\s*\d+\s/gm) ?? []).length;

    const windows = (await cua!.call("list_windows")).result as {
      structuredContent: { windows: Array<{ pid: number; window_id: number; app_name: string; is_on_screen: boolean }> };
    };
    const win = windows.structuredContent.windows.find(
      (w) => w.app_name === ELECTRON_DISPLAY_NAME || w.app_name === "Electron",
    );
    expect(win, `cua-driver did not list the fixture window: ${cuaStderr}`).toBeTruthy();

    const state = (await cua!.call("get_window_state", {
      pid: win!.pid,
      window_id: win!.window_id,
      include_screenshot: false,
    })).result as { structuredContent: { element_count: number; degraded: boolean; degraded_reason?: string } };
    const cuaCount = state.structuredContent.element_count;

    console.log(
      "[diff] Swift indexed rows=%d   cua-driver elements=%d   degraded=%s %s",
      swiftIndexed,
      cuaCount,
      state.structuredContent.degraded,
      state.structuredContent.degraded_reason ?? "",
    );

    expect(swiftIndexed, "Swift engine read an empty tree").toBeGreaterThan(0);
    expect(cuaCount, `cua-driver read an empty tree: ${state.structuredContent.degraded_reason ?? ""}`)
      .toBeGreaterThan(0);
  }, 120_000);
});
