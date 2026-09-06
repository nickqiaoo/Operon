/**
 * Transport for `cua-driver serve`: line-delimited JSON over a Unix socket
 * (a named pipe on Windows), one long-lived connection.
 *
 * Wire shapes, from `rust/crates/cua-driver-core/src/daemon.rs`:
 *
 *   request   {"method":"call","name":"<tool>","args":{...}}
 *             {"method":"list"} | {"method":"describe","name":...}
 *             {"method":"metadata"} | {"method":"session_begin", ...}
 *   response  {"ok":true,"result":...}
 *             {"ok":false,"error":"...","exit_code":1}
 *
 * Two properties of that protocol drive the design here.
 *
 * **There are no request ids.** Responses come back in send order, so matching
 * is strictly FIFO. The daemon guarantees it: each connection is handled by one
 * task that awaits a request to completion before reading the next line. The
 * consequence is that a timeout cannot simply reject one call — a late reply
 * would then be handed to the *next* caller. A timeout therefore poisons the
 * whole connection, and the next call reconnects.
 *
 * **The connection may be long-lived even though their own Rust client opens a
 * fresh one per request.** The server loops on lines within a connection, and a
 * `session_begin` on a connection binds that session's lifetime to it: when the
 * connection EOFs, gracefully or by SIGKILL, the daemon reaps the session. That
 * is exactly the shape Operon needs for `endHostSession`.
 *
 * See docs/cua-driver-migration/design.md.
 */
import type { NativePipeConnection } from "../wire.ts";
import { SkyComputerUseError, SkyComputerUseTransportError } from "../wire.ts";

/** A cua-driver tool result, the payload of a successful `call`. */
export interface CuaToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

interface DaemonEnvelope {
  ok: boolean;
  result?: unknown;
  error?: string;
  exit_code?: number;
}

export interface CuaDaemonRequest {
  method: string;
  name?: string;
  args?: Record<string, unknown>;
  session?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class CuaDaemonTransport {
  private readonly socket: NativePipeConnection;
  /** FIFO, because the protocol carries no request ids. */
  private readonly pending: Array<{
    resolve: (value: DaemonEnvelope) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
  }> = [];
  private buffer = "";
  private closed = false;

  constructor(socket: NativePipeConnection) {
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) =>
      this.fail(new SkyComputerUseTransportError(error.message, { cause: error })),
    );
    socket.on("close", () => this.fail(new SkyComputerUseTransportError("cua-driver connection closed")));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onData(chunk: Uint8Array): void {
    this.buffer += Buffer.from(chunk).toString("utf8");
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      const waiter = this.pending.shift();
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      try {
        waiter.resolve(JSON.parse(line) as DaemonEnvelope);
      } catch (cause) {
        waiter.reject(
          new SkyComputerUseTransportError(`cua-driver sent malformed JSON: ${line.slice(0, 200)}`, { cause }),
        );
      }
    }
  }

  private fail(error: Error): void {
    this.closed = true;
    while (this.pending.length > 0) {
      const waiter = this.pending.shift()!;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  /** Send one request and await its reply. A timeout closes the connection: see
   *  the FIFO note at the top of the file. */
  send(request: CuaDaemonRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<DaemonEnvelope> {
    if (this.closed) {
      return Promise.reject(new SkyComputerUseTransportError("cua-driver connection is closed"));
    }
    return new Promise<DaemonEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new SkyComputerUseTransportError(
            `cua-driver request timed out after ${timeoutMs}ms (${request.method}${request.name ? ` ${request.name}` : ""}); connection dropped because replies are matched in order`,
          ),
        );
        this.socket.end();
      }, timeoutMs);
      this.pending.push({ resolve, reject, timer, method: request.method });
      try {
        this.socket.write(Buffer.from(`${JSON.stringify(request)}\n`, "utf8"));
      } catch (cause) {
        clearTimeout(timer);
        this.pending.pop();
        reject(new SkyComputerUseTransportError(`cua-driver write failed: ${String(cause)}`, { cause }));
      }
    });
  }

  /**
   * Invoke a tool. A transport-level failure and a tool-level refusal are
   * different things and stay different here: the first throws a transport
   * error, the second throws `SkyComputerUseError` carrying whatever structured
   * code the driver returned, so the policy layer can tell "the engine is gone"
   * from "the engine says no".
   */
  async call(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<CuaToolResult> {
    const envelope = await this.send({ method: "call", name, args }, timeoutMs);
    if (!envelope.ok) {
      throw new SkyComputerUseError({
        code: envelope.exit_code ?? -32_000,
        message: envelope.error ?? `cua-driver call ${name} failed`,
        request: args,
        requestType: name,
      });
    }
    const result = (envelope.result ?? {}) as CuaToolResult;
    if (result.isError === true) {
      const text = result.content?.map((part) => part.text ?? "").join(" ").trim();
      const structured = result.structuredContent;
      throw new SkyComputerUseError({
        code: typeof structured?.code === "string" ? -32_000 : -32_000,
        message: text && text !== "" ? text : `cua-driver tool ${name} reported an error`,
        request: args,
        requestType: name,
      });
    }
    return result;
  }

  end(): void {
    this.closed = true;
    this.socket.end();
  }
}
