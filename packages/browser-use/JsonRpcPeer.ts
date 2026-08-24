import { Buffer } from "node:buffer";
import type { Socket } from "node:net";
import { encodeFrame, decodeFrames } from "./wire.ts";

/** A JSON-RPC 2.0 request, client to backend. */
export interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

/**
 * A JSON-RPC peer on one connected socket, backend side.
 *
 * Its only job is to unframe, dispatch by method, and frame the reply. It knows
 * no specific method; that is IabBackend's concern.
 *
 * The accumulating buffer exists because of how sockets behave: one `data` event
 * can carry half a frame or several.
 */
export class JsonRpcPeer {
  // Annotated explicitly: Buffer is generic in recent @types/node, and
  // `subarray()` returns Buffer<ArrayBufferLike>, which is not assignable to the
  // Buffer<ArrayBuffer> that `Buffer.alloc()` infers.
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  private readonly socket: Socket;
  private readonly handlers: Record<string, RpcHandler>;
  private readonly onError?: (e: Error) => void;

  // No parameter properties: vite treats this package as external, so Node loads
  // the .ts source directly with strip-only type erasure, and a parameter
  // property raises ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. See the external list in
  // vite.config.ts.
  constructor(
    socket: Socket,
    handlers: Record<string, RpcHandler>,
    onError?: (e: Error) => void,
  ) {
    this.socket = socket;
    this.handlers = handlers;
    this.onError = onError;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (e) => this.onError?.(e));
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { messages, remainingData } = decodeFrames(this.buffer);
    this.buffer = remainingData;
    for (const raw of messages) void this.dispatch(raw);
  }

  private async dispatch(raw: string) {
    let msg: RpcRequest;
    try {
      msg = JSON.parse(raw) as RpcRequest;
    } catch (e) {
      this.onError?.(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    // A notification has no id and gets no response.
    const id = msg.id ?? null;
    const handler = this.handlers[msg.method];
    if (!handler) {
      if (id !== null) this.writeError(id, `Unknown method: ${msg.method}`);
      return;
    }
    try {
      const result = await handler(msg.params);
      if (id !== null) this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (e) {
      if (id !== null) this.writeError(id, e instanceof Error ? e.message : String(e));
    }
  }

  private writeError(id: number | string, message: string) {
    this.write({ jsonrpc: "2.0", id, error: { code: 1, message } });
  }

  private write(msg: unknown) {
    if (this.socket.destroyed) return;
    try {
      this.socket.write(encodeFrame(JSON.stringify(msg)));
    } catch (e) {
      this.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Push a notification: no id, and no reply from the client. */
  sendNotification(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }
}
