/**
 * Operon's own Computer Use client: the wire layer, framing plus JSON-RPC over
 * nativePipe.
 *
 * Why we wrote our own. The package this originally vendored is proprietary and
 * its NOTICE forbids redistributing it with a product. That was a hard blocker
 * on shipping, not a refactoring preference.
 *
 * Where the contract comes from. It was not guessed by reading a minified
 * bundle. It was recorded behaviourally, by running the reference client against
 * a stub server and capturing the frames it sent; see the sky-wire-oracle recordings,
 * which re-records on every CI run. Read that before changing this file.
 *
 * The server is our own Swift implementation (`native/computer-use`), so both
 * ends of the contract are in this repository.
 */
import { Buffer } from "node:buffer";

/** Protocol version for the ping handshake. Client and server must match exactly;
 *  a mismatch is refused outright. */
export const API_VERSION = "CodexComputerUseIPC-2";

/** Maximum size of a single frame, matching maxFrameBytes in `Framing.swift`. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Env var naming the socket path. */
export const SOCKET_PATH_ENV = "SKY_CUA_NATIVE_PIPE_PATH";

/**
 * Startup-token authentication, specific to operon. The Swift CU engine reads the
 * expected token from its *process env*; whoever connects (the kernel host, or
 * ComputerUseService) sends `operon/authenticate` carrying the same token as its
 * first frame. Another process belonging to the same user cannot read our
 * process env, so it cannot produce the token and the engine closes its
 * connection.
 *
 * `CU_AUTH_TOKEN_ENV` is the env key the *engine* reads, injected when
 * `ComputerUseService` spawns it. The literal has to match `main.swift` exactly,
 * since a constant cannot be shared across the two languages. The token itself
 * stays an in-process value on the connecting side (a host constructor argument,
 * or ComputerUseService.authToken) and is never passed to the kernel through env.
 * The kernel does not send the frame either; the host does.
 */
export const CU_AUTH_TOKEN_ENV = "OPERON_CU_AUTH_TOKEN";
export const CU_AUTHENTICATE_METHOD = "operon/authenticate";

// ------------------------------- Errors -------------------------------

/** Structured error codes a server can return. Our Swift implementation currently
 *  only emits -32000; the rest are kept so another server remains compatible. */
export const ServerErrorCode = {
  senderProcessNotAuthenticated: -10000,
  couldNotGetRequestData: -10001,
  couldNotGetRequestTypeName: -10002,
  couldNotResolveRequestType: -10003,
  unhandledEvent: -10004,
  unknownError: -10005,
  appNotAllowed: -10006,
  runningApplicationNotFound: -10007,
  accessibilityError: -10008,
  permissionsNotGranted: -10009,
  invalidApp: -10010,
  noActiveSession: -10011,
  userStoppedSession: -10012,
  incompatibleClientVersion: -10013,
  permissionsPending: -10014,
  blockedURL: -10015,
  userIntervened: -10016,
  couldNotGetSenderPID: -10017,
  ambiguousApp: -10018,
  couldNotGetBootstrapPort: -10019,
  screenLocked: -10020,
} as const;

/** The server refused explicitly, as a JSON-RPC error. */
export class SkyComputerUseError extends Error {
  code: number;
  request: unknown;
  requestType: string;
  constructor(args: { code: number; message: string; request: unknown; requestType: string }) {
    super(args.message);
    this.name = "SkyComputerUseError";
    this.code = args.code;
    this.request = args.request;
    this.requestType = args.requestType;
  }
}

/** Cannot connect, malformed frame, or invalid protocol. A transport problem
 *  rather than a refusal by the server. */
export class SkyComputerUseTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SkyComputerUseTransportError";
  }
}

// ─────────────────────────── framing ───────────────────────────

/**
 * `[4-byte little-endian uint32 length][UTF-8 JSON]`.
 *
 * Little-endian here is native byte order, not network byte order, matching
 * `Framing.swift` (and browser-use's own `wire.ts`). The supported targets are
 * macOS arm64 and x64, both little-endian.
 */
export function encodeMessageFrame(message: string): Buffer {
  const payload = Buffer.from(message, "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw new SkyComputerUseTransportError(`frame too large: ${payload.length} > ${MAX_FRAME_BYTES}`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * The authentication frame, sent before any real request including ping. It is a
 * notification, carrying no `id`: the Swift `UnixSocketServer` consumes it
 * silently, answers nothing and never routes it. A wrong token closes the
 * connection.
 */
export function encodeAuthFrame(token: string): Buffer {
  return encodeMessageFrame(
    JSON.stringify({ jsonrpc: "2.0", method: CU_AUTHENTICATE_METHOD, params: { token } }),
  );
}

/** Cut every complete frame out of the accumulated buffer and return the leftover
 *  bytes, keeping even half a length prefix. */
export function decodeMessageFrames(buffer: Buffer): { messages: string[]; remainingData: Buffer } {
  const messages: string[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const len = buffer.readUInt32LE(offset);
    if (len > MAX_FRAME_BYTES) {
      throw new SkyComputerUseTransportError(`frame too large: ${len} > ${MAX_FRAME_BYTES}`);
    }
    if (buffer.length - offset < 4 + len) break;
    messages.push(buffer.subarray(offset + 4, offset + 4 + len).toString("utf8"));
    offset += 4 + len;
  }
  return { messages, remainingData: buffer.subarray(offset) };
}

// ─────────────────────────── JSON-RPC ───────────────────────────

export interface JsonRpcOk {
  id: number;
  jsonrpc: "2.0";
  result: unknown;
}
export interface JsonRpcErr {
  id: number;
  jsonrpc: "2.0";
  error: { code: number; message: string };
}

/**
 * Validate a server response: `id` must be a number, `jsonrpc` must be `"2.0"`,
 * exactly one of result and error must be present, and an error must carry a
 * numeric code and a string message. Failing any of these is a transport error.
 */
export function parseJsonRpcResponse(raw: string): JsonRpcOk | JsonRpcErr {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new SkyComputerUseTransportError("Sky Computer Use returned invalid JSON", { cause });
  }
  const invalid = () =>
    new SkyComputerUseTransportError("Sky Computer Use returned an invalid JSON-RPC response");

  if (typeof value !== "object" || value === null) throw invalid();
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "number" || obj.jsonrpc !== "2.0") throw invalid();

  const hasResult = Object.prototype.hasOwnProperty.call(obj, "result");
  const hasError = Object.prototype.hasOwnProperty.call(obj, "error");
  // Exactly one: having both, or neither, is invalid.
  if (hasResult === hasError) throw invalid();

  if (hasResult) return { id: obj.id, jsonrpc: "2.0", result: obj.result };

  const err = obj.error;
  if (typeof err !== "object" || err === null) throw invalid();
  const e = err as Record<string, unknown>;
  if (typeof e.code !== "number" || typeof e.message !== "string") throw invalid();
  return { id: obj.id, jsonrpc: "2.0", error: { code: e.code, message: e.message } };
}

// ─────────────────────────── transport ───────────────────────────

/** The connection `nodeRepl.nativePipe.createConnection` hands back; only these
 *  members are used. */
export interface NativePipeConnection {
  write(data: Uint8Array): void;
  end(): void;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
}

export type CodexMetadata = string | Uint8Array | Record<string, unknown> | null | undefined;

/**
 * Normalise turn metadata: null, undefined and plain objects pass through
 * untouched, while byte views such as Uint8Array are parsed as UTF-8 JSON.
 * (undefined is dropped by JSON.stringify, so the key never reaches the wire,
 * and the server accepts its absence.)
 */
export function normalizeCodexMetadata(meta: CodexMetadata): unknown {
  if (meta == null) return meta;
  if (typeof meta === "object" && !ArrayBuffer.isView(meta)) return meta;
  return JSON.parse(Buffer.from(meta as Uint8Array | string).toString("utf8"));
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  requestType: string;
  request: unknown;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Single-connection JSON-RPC transport. The connection is long-lived and reused
 * across calls.
 *
 * Because it never closes itself, `net.Server.close()` in a test waits on it
 * forever; see the afterAll note in the sky-wire-oracle suite.
 */
export class NativePipeTransport {
  private readonly socket: NativePipeConnection;
  private readonly apiVersion: string;
  private readonly pending = new Map<number, Pending>();
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 0;
  private closed = false;

  constructor(socket: NativePipeConnection, apiVersion: string = API_VERSION) {
    this.socket = socket;
    this.apiVersion = apiVersion;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (e) => this.fail(new SkyComputerUseTransportError(e.message, { cause: e })));
    socket.on("close", () => this.fail(new SkyComputerUseTransportError("Sky Computer Use connection closed")));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onData(chunk: Uint8Array): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    let messages: string[];
    try {
      const decoded = decodeMessageFrames(this.buffer);
      messages = decoded.messages;
      this.buffer = decoded.remainingData;
    } catch (e) {
      this.fail(e instanceof Error ? e : new SkyComputerUseTransportError(String(e)));
      return;
    }
    for (const raw of messages) {
      let response: JsonRpcOk | JsonRpcErr;
      try {
        response = parseJsonRpcResponse(raw);
      } catch (e) {
        this.fail(e instanceof Error ? e : new SkyComputerUseTransportError(String(e)));
        return;
      }
      const p = this.pending.get(response.id);
      if (!p) continue; // Unknown id. The server should not send one, but it is
                        // not worth tearing down the connection over.
      this.pending.delete(response.id);
      clearTimeout(p.timer);
      if ("error" in response) {
        p.reject(
          new SkyComputerUseError({
            code: response.error.code,
            message: response.error.message,
            request: p.request,
            requestType: p.requestType,
          }),
        );
      } else {
        p.resolve(response.result);
      }
    }
  }

  /** A connection-level failure: every in-flight request fails together and new
   *  ones are refused afterwards. */
  private fail(error: Error): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  private call(method: string, params: unknown, timeoutMs: number, requestType: string, request: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new SkyComputerUseTransportError("Sky Computer Use connection is closed"));
    }
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SkyComputerUseTransportError(`Sky Computer Use request timed out after ${timeoutMs}ms (${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, requestType, request });
      try {
        this.socket.write(encodeMessageFrame(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new SkyComputerUseTransportError(`Sky Computer Use write failed: ${String(e)}`));
      }
    });
  }

  /** Handshake. The version must match exactly, and a mismatch is a hard failure:
   *  once versions differ the frame shapes may already have drifted. */
  async ping(timeoutMs = 5000): Promise<void> {
    const result = await this.call("ping", { clientApiVersion: this.apiVersion }, timeoutMs, "ping", null);
    const serverApiVersion = (result as { serverApiVersion?: unknown } | null)?.serverApiVersion;
    if (serverApiVersion !== this.apiVersion) {
      throw new SkyComputerUseTransportError(
        `Sky Computer Use API version mismatch: client=${this.apiVersion} server=${String(serverApiVersion)}`,
      );
    }
  }

  /**
   * Send a `request`. The params shape matches the recorded contract field for field:
   * `{clientApiVersion, codexTurnMetadata?, deadlineUnixMilliseconds, request, requestType}`.
   */
  async request<T>(args: {
    requestType: string;
    request: unknown;
    codexMetadata?: CodexMetadata;
    timeoutSeconds: number;
  }): Promise<T> {
    const timeoutMs = args.timeoutSeconds * 1000;
    const params: Record<string, unknown> = {
      clientApiVersion: this.apiVersion,
      deadlineUnixMilliseconds: Date.now() + timeoutMs,
      request: args.request,
      requestType: args.requestType,
    };
    const meta = normalizeCodexMetadata(args.codexMetadata);
    // JSON.stringify omits undefined, while an explicit null does reach the wire.
    if (meta !== undefined) params.codexTurnMetadata = meta;
    return (await this.call("request", params, timeoutMs, args.requestType, args.request)) as T;
  }
}
