import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { once } from "node:events";
import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeComputerUsePresentationEvent,
  type ComputerUsePresentationEvent,
} from "./presentation.ts";
import { encodeAuthFrame, CU_AUTH_TOKEN_ENV } from "./computer/wire.ts";

export interface ComputerUseServiceExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface ComputerUseServiceOptions {
  /** Path to the operon-computer-use Swift binary. Defaults to the build output
   *  inside this repository. */
  binaryPath?: string;
  /** Domain socket path; must stay under the 104-byte limit. Defaults to a short
   *  name in a temporary directory. */
  socketPath?: string;
  /** Hands diagnostics to the host when the Swift service exits unexpectedly.
   *  A deliberate stop does not fire it. */
  onExit?: (exit: ComputerUseServiceExit) => void;
  /**
   * Restart backoff after an unexpected exit. Without one, recovery only happens
   * on the next `start()`. A host process should supply a bounded sequence so a
   * persistently crashing engine cannot spin.
   */
  restartDelaysMs?: readonly number[];
  /** Menu bar and capture status events from Swift, so a desktop host can render
   *  the inactive-window preview. */
  onPresentationEvent?: (event: ComputerUsePresentationEvent) => void;
  /**
   * Engine diagnostics, one line at a time.
   *
   * stderr used to be buffered for the exit report only, so anything that went
   * wrong while the service stayed alive — a denied TCC grant being the case
   * that cost us an evening — was invisible to the host log.
   */
  onStderrLine?: (line: string) => void;
}

/** Both macOS grants the engine needs, as the engine itself sees them. */
export interface ComputerUsePermissions {
  accessibility: boolean;
  screenRecording: boolean;
}

export type ComputerUsePermissionKind = keyof ComputerUsePermissions;

/**
 * Resolve the Swift service binary.
 *
 * Prefer release / dist over debug. Debug was historically the only default and
 * silently kept serving a stale binary after `swift build -c release` — which
 * is exactly how cursor-ordering fixes never reached a running Operon session.
 */
function defaultBinaryPath(): string {
  // packages/computer-use/ → repo root
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const candidates = [
    path.join(repoRoot, "dist-operon-runtime", "operon-computer-use"),
    path.join(repoRoot, "native/computer-use/.build/arm64-apple-macosx/release/operon-computer-use"),
    path.join(repoRoot, "native/computer-use/.build/release/operon-computer-use"),
    path.join(repoRoot, "native/computer-use/.build/debug/operon-computer-use"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Last resort: path that start() will report as missing.
  return candidates[candidates.length - 1]!;
}

/**
 * The default socket lives in `~/.operon/run`, whose parent is 0700, rather than
 * `/tmp`. That removes both cross-user visibility and the chance of another
 * process claiming the path first. It comes to about 46 bytes, well inside the
 * 104-byte sun_path limit; macOS `/var/folders` is the long one.
 */
function defaultSocketPath(): string {
  return path.join(os.homedir(), ".operon", "run", `opcu-${process.pid}.sock`);
}

function removeSocket(socketPath: string): void {
  try {
    rmSync(socketPath, { force: true });
  } catch {
    // The next bind or connect will return a more specific error.
  }
}

function canConnect(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

/**
 * Manages the lifecycle of the operon-computer-use Swift service: spawning it,
 * waiting for its socket, and handling exit. A host gets a usable socketPath in
 * one line instead of spawning anything itself.
 */
export class ComputerUseService {
  readonly binaryPath: string;
  readonly socketPath: string;
  /**
   * Per-instance authentication secret. The Swift engine receives the expected
   * value through its process env ({@link CU_AUTH_TOKEN_ENV}) and the kernel
   * receives it through processEnv, so both compare the same value. It lives as
   * long as the instance: an engine restarted after a crash reuses the same
   * token, so connections already baked into a kernel stay valid. Another
   * process belonging to the same user cannot read this process's env, and so
   * cannot obtain it.
   */
  readonly authToken: string = randomBytes(32).toString("hex");
  private proc: ChildProcess | undefined;
  private startPromise: Promise<void> | undefined;
  private readonly onExit: ComputerUseServiceOptions["onExit"];
  private readonly restartDelaysMs: readonly number[];
  private readonly onPresentationEvent: ComputerUseServiceOptions["onPresentationEvent"];
  private readonly onStderrLine: ComputerUseServiceOptions["onStderrLine"];
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private restartAttempt = 0;
  private stopped = true;

  constructor(opts: ComputerUseServiceOptions = {}) {
    this.binaryPath = opts.binaryPath ?? defaultBinaryPath();
    // A unix socket's sun_path caps at about 104 bytes, so the path has to stay
    // short, which rules out the macOS /var/folders tmpdir. The default is
    // ~/.operon/run (0700) rather than /tmp; see defaultSocketPath.
    this.socketPath = opts.socketPath ?? defaultSocketPath();
    this.onExit = opts.onExit;
    this.restartDelaysMs = opts.restartDelaysMs ?? [];
    this.onPresentationEvent = opts.onPresentationEvent;
    this.onStderrLine = opts.onStderrLine;
  }

  get running(): boolean {
    return this.proc != null && this.proc.exitCode == null;
  }

  /** A socket file existing does not mean anything is listening. Check with a
   *  real connection. */
  async isReady(timeoutMs = 250): Promise<boolean> {
    if (!this.running) return false;
    return await canConnect(this.socketPath, timeoutMs);
  }

  /** Start the service and wait for a real socket connection. Restarts in place
   *  if it has died. */
  async start(timeoutMs = 8000): Promise<void> {
    this.stopped = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.startPromise) return await this.startPromise;
    if (this.running && await this.isReady()) return;
    // `isReady()` awaits, so concurrent callers can converge here. Check again.
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
        `operon-computer-use is not built: ${this.binaryPath}\nRun swift build in native/computer-use first, or pass binaryPath.`,
      );
    }

    if (this.running) await this.stop();
    // The socket directory has to exist and be owner-only (0700). Together with
    // the Swift side's chmod 0600 that keeps other users out.
    mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    removeSocket(this.socketPath);

    const child = spawn(this.binaryPath, [this.socketPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPERON_CU_PRESENTATION_EVENTS: "1",
        // Startup token: the Swift engine refuses connections that cannot present
        // it. Passed through env rather than argv, since argv is visible to
        // anyone running `ps`. Another process cannot read this one's env.
        [CU_AUTH_TOKEN_ENV]: this.authToken,
        // Software cursor on by default (Codex-style desktop feedback). Explicit
        // OPEN_COMPUTER_USE_VISUAL_CURSOR=0 in the host env still disables it.
        OPEN_COMPUTER_USE_VISUAL_CURSOR:
          process.env.OPEN_COMPUTER_USE_VISUAL_CURSOR ?? "1",
      },
    });
    this.proc = child;

    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout += String(chunk);
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const event = decodeComputerUsePresentationEvent(line);
        if (event) this.onPresentationEvent?.(event);
      }
      // PiP publishes only remote-context metadata, so an unterminated line is
      // always a protocol error rather than a partially received image.
      if (stdout.length > 1024 * 1024) stdout = "";
    });
    child.stderr?.setEncoding("utf8");
    let stderrLine = "";
    child.stderr?.on("data", (chunk: string | Buffer) => {
      const text = String(chunk);
      // Keep the tail for the exit report, and forward complete lines live so
      // the host log shows engine problems while the service is still running.
      stderr = `${stderr}${text}`.slice(-16_384);
      stderrLine += text;
      for (;;) {
        const newline = stderrLine.indexOf("\n");
        if (newline < 0) break;
        const line = stderrLine.slice(0, newline).trim();
        stderrLine = stderrLine.slice(newline + 1);
        if (line) this.onStderrLine?.(line);
      }
      if (stderrLine.length > 8192) stderrLine = "";
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("exit", (code, signal) => {
      // `stop()` clears this.proc first, so an exit only counts as unexpected
      // while the current instance still holds it.
      if (this.proc !== child) return;
      this.proc = undefined;
      removeSocket(this.socketPath);
      this.onPresentationEvent?.({ type: "ended", reason: "service-exited" });
      this.onExit?.({ code, signal, stderr: stderr.trim() });
      this.scheduleRestart();
    });

    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (spawnError) throw new Error(`operon-computer-use failed to start: ${spawnError.message}`);
        if (child.exitCode != null || child.signalCode != null) {
          const detail = stderr.trim();
          throw new Error(`operon-computer-use exited immediately after starting${detail ? `: ${detail}` : ""}`);
        }
        if (await canConnect(this.socketPath, 100)) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("operon-computer-use socket did not become ready in time");
    } catch (error) {
      if (this.proc === child) await this.terminateCurrentProcess();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    await this.terminateCurrentProcess();
    this.onPresentationEvent?.({ type: "ended", reason: "service-stopped" });
  }

  async endHostSession(hostSessionID: string, timeoutMs = 1000): Promise<void> {
    if (!this.running || !hostSessionID) return;
    await this.control("operon/session-ended", { hostSessionID }, timeoutMs);
  }

  /**
   * Both macOS grants, read from the engine process.
   *
   * TCC follows the running binary, so only the engine can answer this — the
   * Electron host asking on its own behalf would report the wrong process.
   * Returns undefined when the engine is not running (Computer Use is off).
   */
  async permissions(timeoutMs = 2000): Promise<ComputerUsePermissions | undefined> {
    if (!this.running) return undefined;
    const result = await this.control("operon/permissions", undefined, timeoutMs);
    if (result == null || typeof result !== "object") return undefined;
    const record = result as Record<string, unknown>;
    return {
      accessibility: record.accessibility === true,
      screenRecording: record.screenRecording === true,
    };
  }

  /** Open the System Settings pane for a grant, on the machine running the engine. */
  async openPermissionSettings(
    permission: ComputerUsePermissionKind,
    timeoutMs = 2000,
  ): Promise<void> {
    if (!this.running) throw new Error("Computer Use engine is not running");
    await this.control("operon/open-permission-settings", { permission }, timeoutMs);
  }

  /** One-shot JSON-RPC control call on its own connection (framing = 4B LE + JSON). */
  private async control(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const request = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(params === undefined ? {} : { params }),
      }),
      "utf8",
    );
    const frame = Buffer.allocUnsafe(4 + request.length);
    frame.writeUInt32LE(request.length, 0);
    request.copy(frame, 4);

    return await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let settled = false;
      let response = Buffer.alloc(0);
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(
        () => finish(new Error(`Computer Use ${method} request timed out`)),
        timeoutMs,
      );
      const finishAndClear = (error?: Error, result?: unknown) => {
        clearTimeout(timer);
        finish(error, result);
      };

      socket.once("connect", () => {
        // The authentication frame goes first; Swift consumes it silently and
        // answers nothing. Real request frames follow.
        socket.write(encodeAuthFrame(this.authToken));
        socket.write(frame);
      });
      socket.once("error", (error) => finishAndClear(error));
      socket.on("data", (chunk: Buffer) => {
        response = Buffer.concat([response, chunk]);
        if (response.length < 4) return;
        const payloadLength = response.readUInt32LE(0);
        if (response.length < payloadLength + 4) return;
        try {
          const payload = JSON.parse(
            response.subarray(4, payloadLength + 4).toString("utf8"),
          ) as Record<string, unknown>;
          if (payload.error != null) {
            finishAndClear(
              new Error(`Computer Use ${method} failed: ${JSON.stringify(payload.error)}`),
            );
            return;
          }
          finishAndClear(undefined, payload.result);
        } catch (error) {
          finishAndClear(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  private async terminateCurrentProcess(): Promise<void> {
    const p = this.proc;
    this.proc = undefined;
    if (p) {
      p.kill();
      if (p.exitCode == null) {
        await Promise.race([once(p, "exit"), new Promise((r) => setTimeout(r, 1000))]);
      }
    }
    removeSocket(this.socketPath);
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartDelaysMs.length === 0 || this.restartTimer) return;
    const delay = this.restartDelaysMs[
      Math.min(this.restartAttempt, this.restartDelaysMs.length - 1)
    ] ?? 0;
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopped) return;
      void this.start().catch(() => this.scheduleRestart());
    }, Math.max(0, delay));
    this.restartTimer.unref?.();
  }
}
