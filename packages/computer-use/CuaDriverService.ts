/**
 * Lifecycle for the `cua-driver serve` daemon, the counterpart to
 * {@link ComputerUseService} for the Swift engine.
 *
 * Four things here are not obvious and each has a reason.
 *
 * **Spawn directly, never through `open`.** macOS attributes Accessibility and
 * Screen Recording to the *responsible process*: the app at the top of the launch
 * chain. A child started with `spawn` stays inside Operon's responsibility chain,
 * so it answers TCC checks with Operon's grants and the user is never asked a
 * second time. Handing it to LaunchServices would make it its own responsible
 * process and lose that. Measured: with `CUA_DRIVER_EMBEDDED=1` the daemon
 * reports `attribution: "host"` and inherits the grants; started detached, its
 * `responsible_ppid` becomes 1 and the inheritance is gone.
 *
 * **`CUA_DRIVER_EMBEDDED=1` is required.** Standalone cua-driver deliberately
 * disclaims responsibility so its permissions attach to a stable
 * `com.trycua.driver` identity. Embedded mode turns that off. Only the exact
 * value `1` enables it.
 *
 * **Telemetry and update checks are switched off.** The daemon sends product
 * telemetry by default and carries its own updater. Neither belongs in a binary
 * Operon ships inside its own bundle.
 *
 * **stdin is held open as a liveness signal.** The daemon watches it; when this
 * process dies the pipe closes and it knows immediately, without polling.
 *
 * See docs/cua-driver-migration/design.md.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CuaDriverServiceOptions {
  binaryPath?: string;
  socketPath?: string;
  /** Advisory label echoed in the daemon's permission reporting and logs. It is
   *  not a trust signal: trust comes from the OS responsibility chain. */
  hostBundleId?: string;
  /** `standard` (default), `bounded`, or `unrestricted`. Fixed for the daemon's
   *  lifetime and not changeable by a tool call. */
  permissionMode?: "standard" | "bounded" | "unrestricted";
  /** The agent cursor overlay is on by default in cua-driver. */
  cursorOverlay?: boolean;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => void;
  onStderrLine?: (line: string) => void;
  restartDelaysMs?: readonly number[];
}

function defaultBinaryPath(): string {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const candidates = [
    path.join(repoRoot, "dist-operon-runtime", "cua-driver"),
    path.join(repoRoot, "native/cua-driver/cua-driver"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1]!;
}

/** Same reasoning as the Swift service: `~/.operon/run` is 0700 and short, while
 *  the macOS temp dir overruns the ~104-byte sun_path limit. */
function defaultSocketPath(): string {
  return path.join(os.homedir(), ".operon", "run", `cua-${process.pid}.sock`);
}

function canConnect(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

export class CuaDriverService {
  readonly binaryPath: string;
  readonly socketPath: string;
  private readonly hostBundleId: string;
  private readonly permissionMode: string;
  private readonly cursorOverlay: boolean;
  private readonly onExit: CuaDriverServiceOptions["onExit"];
  private readonly onStderrLine: CuaDriverServiceOptions["onStderrLine"];
  private readonly restartDelaysMs: readonly number[];
  private proc: ChildProcess | undefined;
  private startPromise: Promise<void> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private restartAttempt = 0;
  private stopped = true;

  constructor(options: CuaDriverServiceOptions = {}) {
    this.binaryPath = options.binaryPath ?? defaultBinaryPath();
    this.socketPath = options.socketPath ?? defaultSocketPath();
    this.hostBundleId = options.hostBundleId ?? "top.chatcode.operon";
    this.permissionMode = options.permissionMode ?? "standard";
    this.cursorOverlay = options.cursorOverlay ?? true;
    this.onExit = options.onExit;
    this.onStderrLine = options.onStderrLine;
    this.restartDelaysMs = options.restartDelaysMs ?? [];
  }

  get running(): boolean {
    return this.proc != null && this.proc.exitCode == null;
  }

  async isReady(timeoutMs = 250): Promise<boolean> {
    if (!this.running) return false;
    return await canConnect(this.socketPath, timeoutMs);
  }

  async start(timeoutMs = 15_000): Promise<void> {
    this.stopped = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.startPromise) return await this.startPromise;
    if (this.running && (await this.isReady())) return;
    if (this.startPromise) return await this.startPromise;

    const starting = this.startFresh(timeoutMs);
    this.startPromise = starting;
    try {
      await starting;
      this.restartAttempt = 0;
    } finally {
      if (this.startPromise === starting) this.startPromise = undefined;
    }
  }

  private async startFresh(timeoutMs: number): Promise<void> {
    if (!existsSync(this.binaryPath)) {
      throw new Error(
        `cua-driver is not installed: ${this.binaryPath}\n`
        + "Place the release binary at dist-operon-runtime/cua-driver, or pass binaryPath.",
      );
    }
    if (this.running) await this.stop();
    mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    rmSync(this.socketPath, { force: true });

    const args = ["serve", "--embedded", "--socket", this.socketPath];
    if (!this.cursorOverlay) args.push("--no-overlay");

    const child = spawn(this.binaryPath, args, {
      // stdin stays a pipe on purpose: it is the daemon's liveness signal.
      stdio: ["pipe", "ignore", "pipe"],
      env: {
        ...process.env,
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_HOST_BUNDLE_ID: this.hostBundleId,
        CUA_DRIVER_PERMISSION_MODE: this.permissionMode,
        // Operon ships this binary; it does not update or phone home on its own.
        CUA_DRIVER_RS_UPDATE_CHECK: "0",
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
        CUA_TELEMETRY_ENABLED: "0",
      },
    });
    this.proc = child;

    let stderr = "";
    let stderrLine = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
      stderrLine += chunk;
      for (;;) {
        const newline = stderrLine.indexOf("\n");
        if (newline < 0) break;
        const line = stderrLine.slice(0, newline).trim();
        stderrLine = stderrLine.slice(newline + 1);
        if (line) this.onStderrLine?.(line);
      }
      if (stderrLine.length > 8192) stderrLine = "";
    });

    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.once("exit", (code, signal) => {
      if (this.proc !== child) return;
      this.proc = undefined;
      rmSync(this.socketPath, { force: true });
      this.onExit?.({ code, signal, stderr: stderr.trim() });
      this.scheduleRestart();
    });

    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (spawnError) throw new Error(`cua-driver failed to start: ${spawnError.message}`);
        if (child.exitCode != null || child.signalCode != null) {
          const detail = stderr.trim();
          throw new Error(`cua-driver exited immediately after starting${detail ? `: ${detail}` : ""}`);
        }
        if (await canConnect(this.socketPath, 100)) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("cua-driver socket did not become ready in time");
    } catch (error) {
      if (this.proc === child) await this.terminate();
      throw error;
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartDelaysMs.length === 0) return;
    const delay = this.restartDelaysMs[Math.min(this.restartAttempt, this.restartDelaysMs.length - 1)]!;
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start().catch(() => {});
    }, delay);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    await this.terminate();
  }

  private async terminate(): Promise<void> {
    const child = this.proc;
    this.proc = undefined;
    if (!child || child.exitCode != null) return;
    child.stdin?.end();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    rmSync(this.socketPath, { force: true });
  }
}
