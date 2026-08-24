/**
 * Client-side transport for operon's browser SDK.
 *
 * `JsonRpcPeer.ts` is the backend side, receiving requests and answering them;
 * this is the client side, sending requests and awaiting responses. Both share
 * the framing in `../wire.ts`: a 4-byte native-endian uint32 followed by UTF-8
 * JSON.
 */
import { Buffer } from "node:buffer";
import { encodeFrame, decodeFrames } from "../wire.ts";
import { SessionParamsSource } from "./session.ts";

/** The connection `nodeRepl.nativePipe.createConnection` returns; only these
 *  members are used. */
export interface PipeConnection {
  write(data: Uint8Array): void;
  end(): void;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
}

interface NodeReplLike {
  nativePipe?: { createConnection?: (path: string) => Promise<PipeConnection> };
}

/** nativePipe is only reachable from the kernel realm. The nodeRepl inside the vm
 *  sandbox is the restricted one. */
export async function connectPipe(socketPath: string): Promise<PipeConnection> {
  const create = (globalThis as { nodeRepl?: NodeReplLike }).nodeRepl?.nativePipe?.createConnection;
  if (typeof create !== "function") {
    throw new Error("Browser Use requires nodeRepl.nativePipe support");
  }
  return await create(socketPath);
}

/** A CDP event pushed by a backend: the payload of the `onCDPEvent` notification
 *  (see IabBackend.broadcastCdpEvent). */
export interface CdpEventNotification {
  source: { tabId: number; sessionId?: string; targetId?: string };
  method: string;
  params?: unknown;
}

/** Download status pushed by a backend, via the `onDownloadChange` notification. */
export interface DownloadChange {
  id: string;
  filename: string;
  status: string;
  url: string;
  session_id: string;
}

export class BrowserRpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "BrowserRpcError";
    this.code = code;
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * A JSON-RPC client over one backend connection.
 *
 * `sendSessionRequest` merges the session triple into the params automatically.
 * Every backend handler reads `session_id` out of the params (see `reqSession` in
 * IabBackend), so omitting it gets the call attributed to a different session.
 */
export class BackendConnection {
  private readonly socket: PipeConnection;
  private readonly pending = new Map<number, Pending>();
  private readonly session = new SessionParamsSource();
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 0;
  private closed = false;
  private readonly cdpListeners = new Set<(e: CdpEventNotification) => void>();
  private readonly downloadListeners = new Set<(c: DownloadChange) => void>();

  constructor(socket: PipeConnection) {
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (e) => this.fail(e));
    socket.on("close", () => this.fail(new Error("Browser Use backend connection closed")));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onData(chunk: Uint8Array): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const { messages, remainingData } = decodeFrames(this.buffer);
    this.buffer = remainingData;
    for (const raw of messages) {
      let msg: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
      try {
        msg = JSON.parse(raw) as typeof msg;
      } catch {
        continue; // Bad frame: skip it rather than tearing down the connection.
      }
      // No id means a notification, and these have to be handled. The backend
      // pushes CDP events through `onCDPEvent`, and after `Fetch.enable` Chrome
      // pauses the document response waiting for `Fetch.continueRequest`. Leave
      // this channel unconsumed and `Page.navigate` never returns on any real
      // page; see sdk-locator-real.test.ts.
      if (typeof msg.id !== "number") {
        const note = msg as unknown as { method?: string; params?: unknown };
        if (note.method === "onCDPEvent" && note.params != null) {
          for (const cb of this.cdpListeners) {
            try { cb(note.params as CdpEventNotification); } catch { /* One listener throwing must not affect the others. */ }
          }
        } else if (note.method === "onDownloadChange" && note.params != null) {
          for (const cb of this.downloadListeners) {
            try { cb(note.params as unknown as DownloadChange); } catch { /* As above. */ }
          }
        }
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error != null) {
        const code = typeof msg.error.code === "number" ? msg.error.code : -1;
        const message = typeof msg.error.message === "string" ? msg.error.message : "backend error";
        p.reject(new BrowserRpcError(code, message));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  /** Subscribe to CDP events pushed by the backend; returns an unsubscribe function. */
  onCdpEvent(cb: (e: CdpEventNotification) => void): () => void {
    this.cdpListeners.add(cb);
    return () => this.cdpListeners.delete(cb);
  }

  /** Subscribe to download status pushed by the backend; returns an unsubscribe
   *  function. */
  onDownloadChange(cb: (c: DownloadChange) => void): () => void {
    this.downloadListeners.add(cb);
    return () => this.downloadListeners.delete(cb);
  }

  /** A bare call with no session params. Rarely useful outside discovery, since
   *  every backend handler wants a session_id. */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Browser Use backend connection is closed"));
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs == null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Browser Use request timed out after ${timeoutMs}ms (${method})`));
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
      } catch (e) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error(`Browser Use write failed: ${String(e)}`));
      }
    });
  }

  /**
   * A call carrying the session triple; every backend handler goes through this.
   * The session params are merged into every call, `getInfo` included, which is
   * how a backend knows who is asking, and is what makes echo mode possible (see
   * the sessionId comment in IabBackend).
   */
  sendSessionRequest<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const merged = { ...(params ?? {}), ...this.session.get() };
    return this.request(method, merged, timeoutMs) as Promise<T>;
  }

  close(): void {
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* Already closed. */
    }
  }
}
