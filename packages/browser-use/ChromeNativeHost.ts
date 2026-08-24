import { Buffer } from "node:buffer";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { backendSocketDir, backendSocketPath, decodeFrames, encodeFrame } from "./wire.ts";
import { authorizePeer } from "./peer-auth.ts";

/**
 * Chrome native messaging host for the extension backend.
 *
 * The extension *is* the backend; this is only the pipe that lets a client reach it:
 *
 *   browser-client ──unix socket──▶ ChromeNativeHost ──stdio──▶ Operon Chrome extension
 *   (kernel)        /tmp/operon-      (this file)     native      (chrome.debugger / CDP)
 *                   browser-use/      spawned by       messaging
 *                   <id>.sock         Chrome
 *
 * It deliberately understands no method names. Both sides speak the same framing —
 * 4-byte native-endian length prefix + UTF-8 JSON — because Chrome native messaging and
 * the Browser Use socket happen to have made the same choice. That coincidence is the
 * entire reason this can stay a dumb relay: frames go through unparsed except for `id`.
 *
 * Why we did not reuse open-browser-use's Go relay (plan §4.2): it is 383 lines of dumb
 * forwarding, so porting is cheap, while adopting it would mean shipping a third-party Go
 * binary inside a signed Electron app — separate codesigning and notarization, for both
 * architectures, in exchange for nothing. A native messaging host does not have to be a
 * compiled binary; the manifest's `path` just needs to be executable, so a shell script
 * that execs our already-signed main binary is enough.
 *
 * ## Message size
 *
 * Chrome caps a message *from* the host at 1MB, and one *to* the host at 4GB. The capped
 * direction carries only RPC requests, which are small; screenshots and DOM snapshots
 * travel the other way, extension → host, under the 4GB ceiling. (Our replication plan
 * flagged this as an unverified risk to screenshots and had the direction backwards.)
 * We still bound frames on both sides so a corrupt length prefix cannot make us allocate
 * unboundedly.
 */

/** Refuse any frame larger than this. Chrome's own ceiling for host→Chrome is 1MB. */
export const MAX_FRAME_BYTES = 512 * 1024 * 1024;

/** A socket that has not answered the sweep by now is presumed live and left alone. */
const STALE_PROBE_TIMEOUT_MS = 1_000;

export interface ChromeNativeHostOptions {
  /** Chrome native messaging pipe. Defaults to this process's stdio. */
  stdin?: Readable;
  stdout?: Writable;
  /** Overrides the discovery directory. Defaults to Operon's Browser Use directory. */
  socketDir?: string;
  /** Fixes the socket path outright, bypassing `socketDir` and the random id. */
  socketPath?: string;
  /** Non-fatal problems: a malformed frame, a client that died mid-write. */
  onError?: (error: Error) => void;
  /** Called when Chrome closes the stdio pipe, which means the extension is gone. */
  onExtensionDisconnect?: () => void;
}

interface Client {
  socket: net.Socket;
  buffer: Buffer<ArrayBufferLike>;
}

interface PendingRequest {
  client: Client;
  /** The id the client used, restored on the way back. */
  originalId: unknown;
  /** Compatibility response wrapper for extensions that only expose executeCdp. */
  responseTransform?: "cached-expression";
}

interface RpcMessage {
  id?: unknown;
  method?: unknown;
  [key: string]: unknown;
}

export class ChromeNativeHost {
  private readonly opts: ChromeNativeHostOptions;
  private readonly stdin: Readable;
  private readonly stdout: Writable;
  private readonly clients = new Set<Client>();
  /** Rewritten id -> who asked. */
  private readonly pending = new Map<string, PendingRequest>();
  /**
   * Some Chrome extension builds only implement executeCdp, while the Browser Use client
   * sends the large Playwright bootstrap through executeCdpWithCachedExpression. Keep that
   * transport optimization in the native host so both extension generations work.
   */
  private readonly cachedCdpExpressions = new Map<string, string>();
  private server: net.Server | null = null;
  private socketPath = "";
  private extensionBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private nextRequestId = 0;
  private closed = false;

  constructor(options: ChromeNativeHostOptions = {}) {
    this.opts = options;
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
  }

  /** The socket clients connect on. Only meaningful once `listen()` resolves. */
  get path(): string {
    return this.socketPath;
  }

  async listen(): Promise<string> {
    const dir = this.opts.socketDir ?? backendSocketDir();
    const id = randomId();
    this.socketPath = this.opts.socketPath ?? (this.opts.socketDir ? path.join(dir, `${id}.sock`) : backendSocketPath(id));
    // The client discovers backends by reading this directory, so it has to exist.
    await fs.promises.mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    // A killed process leaves its socket file behind, and the leftover would EADDRINUSE us.
    await fs.promises.rm(this.socketPath, { force: true });

    this.stdin.on("data", (chunk: Buffer) => this.onExtensionData(chunk));
    this.stdin.on("end", () => this.onExtensionEnd());
    this.stdin.on("error", (error: Error) => this.fail(error));

    const server = net.createServer((socket) => {
      // Code-signature peer verification. Off by default and enforced only in
      // signed release builds; see peer-auth.ts.
      if (!authorizePeer(socket)) {
        socket.destroy();
        return;
      }
      this.addClient(socket);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    await fs.promises.chmod(this.socketPath, 0o600);
    // Deliberately not awaited: we are reachable now, and nothing about being discoverable
    // should wait on a scan of someone else's litter.
    void this.sweepStaleSockets();
    return this.socketPath;
  }

  /**
   * Delete socket files nobody is listening on.
   *
   * Cleaning up on the way out cannot be the whole story: the dev server SIGKILLs this process
   * on every rebuild, and SIGKILL is uncatchable, so `close()` never runs and the file stays.
   * Nothing else sweeps this directory — it is shared with the ChatGPT app, which leaks the same
   * way — so the corpses accumulate for as long as the machine is up. They are not free: the
   * client discovers backends by connecting to *every* entry in turn, so each one is another
   * connect standing between an agent and `browsers.get()`.
   *
   * Only ECONNREFUSED is removed. That is the kernel saying nothing is bound to the path, which
   * makes the file garbage no matter whose it was. Anything that answers — our own backend,
   * another Operon window's — is left alone, as is anything that fails some other way.
   */
  private async sweepStaleSockets(): Promise<void> {
    const dir = path.dirname(this.socketPath);
    const entries = await fs.promises.readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(dir, entry);
        if (target === this.socketPath) return;
        if (!(await isUnbound(target))) return;
        await fs.promises.rm(target, { force: true }).catch(() => {});
      }),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const server = this.server;
    this.server = null;
    // Destroy live connections first: server.close() only stops new ones and would
    // otherwise wait forever on the client's long-lived connection.
    for (const client of this.clients) client.socket.destroy();
    this.clients.clear();
    this.pending.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.socketPath) {
      await fs.promises.rm(this.socketPath, { force: true }).catch(() => {});
    }
  }

  private addClient(socket: net.Socket): void {
    const client: Client = { socket, buffer: Buffer.alloc(0) };
    this.clients.add(client);
    socket.on("data", (chunk: Buffer) => this.onClientData(client, chunk));
    socket.on("error", (error: Error) => this.fail(error));
    socket.once("close", () => {
      this.clients.delete(client);
      // Drop this client's in-flight requests: their replies have nowhere to go, and
      // leaving them would leak an entry per request for the life of the host.
      for (const [id, request] of this.pending) {
        if (request.client === client) this.pending.delete(id);
      }
    });
  }

  private onClientData(client: Client, chunk: Buffer): void {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    if (client.buffer.length > MAX_FRAME_BYTES) {
      this.fail(new Error("Client frame exceeds the maximum size"));
      client.socket.destroy();
      return;
    }
    const { messages, remainingData } = decodeFrames(client.buffer);
    client.buffer = remainingData;
    for (const raw of messages) this.forwardToExtension(client, raw);
  }

  /**
   * Client → extension, rewriting the request id.
   *
   * Several clients share one extension and each numbers its requests from zero, so two
   * of them will collide on id 1 in short order. We swap in an id unique to this host and
   * restore the client's own on the way back — the only reason this relay parses at all.
   */
  private forwardToExtension(client: Client, raw: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(raw) as RpcMessage;
    } catch (error) {
      this.fail(asError(error));
      return;
    }
    // No id means a notification: nothing will come back, so nothing to track.
    if (message.id === undefined) {
      this.writeToExtension(raw);
      return;
    }
    let outbound = message;
    let responseTransform: PendingRequest["responseTransform"];
    if (message.method === "executeCdpWithCachedExpression") {
      const params = isRecord(message.params) ? message.params : null;
      if (params == null || typeof params.expressionCacheKey !== "string") {
        this.writeToClient(client, {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32602,
            message: "executeCdpWithCachedExpression requires expressionCacheKey",
          },
        });
        return;
      }
      const expressionCacheKey = params.expressionCacheKey;
      const commandParams = isRecord(params.commandParams) ? params.commandParams : {};
      const suppliedExpression =
        typeof commandParams.expression === "string" ? commandParams.expression : undefined;
      if (suppliedExpression != null) {
        this.cachedCdpExpressions.set(expressionCacheKey, suppliedExpression);
      }
      const expression =
        suppliedExpression ?? this.cachedCdpExpressions.get(expressionCacheKey);
      if (expression == null) {
        this.writeToClient(client, {
          jsonrpc: "2.0",
          id: message.id,
          result: { kind: "cache-miss" },
        });
        return;
      }
      const { expressionCacheKey: _expressionCacheKey, ...executeCdpParams } = params;
      outbound = {
        ...message,
        method: "executeCdp",
        params: {
          ...executeCdpParams,
          commandParams: { ...commandParams, expression },
        },
      };
      responseTransform = "cached-expression";
    }
    const hostId = `operon:${++this.nextRequestId}`;
    const originalId = message.id;
    this.pending.set(hostId, { client, originalId, responseTransform });
    try {
      this.writeToExtension(JSON.stringify({ ...outbound, id: hostId }));
    } catch (error) {
      this.pending.delete(hostId);
      this.writeToClient(client, {
        jsonrpc: "2.0",
        id: originalId,
        error: { code: -32000, message: asError(error).message },
      });
    }
  }

  private onExtensionData(chunk: Buffer): void {
    this.extensionBuffer = Buffer.concat([this.extensionBuffer, chunk]);
    if (this.extensionBuffer.length > MAX_FRAME_BYTES) {
      this.fail(new Error("Extension frame exceeds the maximum size"));
      this.extensionBuffer = Buffer.alloc(0);
      return;
    }
    const { messages, remainingData } = decodeFrames(this.extensionBuffer);
    this.extensionBuffer = remainingData;
    for (const raw of messages) this.dispatchFromExtension(raw);
  }

  /**
   * Extension → client. A reply goes back to whoever asked; a notification goes to everyone.
   *
   * Broadcasting is how notifications work, not a fallback for replies we cannot place:
   * onCDPEvent and onDownloadChange carry no id because the extension is telling every
   * client at once, and each filters by its own attached tabs.
   *
   * So an orphaned reply — one whose client disconnected while it was in flight — is
   * dropped, not broadcast. Broadcasting it would hand one session's response, page content
   * and all, to every other client, including one that just connected and never asked for
   * anything. The discriminator is JSON-RPC's own: replies carry result/error, notifications
   * carry method.
   */
  private dispatchFromExtension(raw: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(raw) as RpcMessage;
    } catch (error) {
      this.fail(asError(error));
      return;
    }
    if (typeof message.id === "string") {
      const request = this.pending.get(message.id);
      if (request) {
        this.pending.delete(message.id);
        const result =
          request.responseTransform === "cached-expression" &&
          Object.prototype.hasOwnProperty.call(message, "result")
            ? { kind: "executed", result: message.result }
            : message.result;
        this.writeToClient(request.client, {
          ...message,
          ...(Object.prototype.hasOwnProperty.call(message, "result") ? { result } : {}),
          id: request.originalId,
        });
        return;
      }
    }
    if (typeof message.method !== "string") {
      this.fail(new Error(`Dropped an orphaned reply for request ${String(message.id)}`));
      return;
    }
    for (const client of this.clients) this.writeRawToClient(client, raw);
  }

  private writeToClient(client: Client, message: unknown): void {
    this.writeRawToClient(client, JSON.stringify(message));
  }

  private writeRawToClient(client: Client, raw: string): void {
    if (client.socket.destroyed) return;
    try {
      client.socket.write(encodeFrame(raw));
    } catch (error) {
      this.fail(asError(error));
    }
  }

  /**
   * The one place allowed to touch stdout. stdout *is* the protocol pipe: a stray
   * console.log, an Electron startup warning, or a Node deprecation notice lands in the
   * frame stream and desynchronizes it permanently. The process entry point must redirect
   * stdout before anything else runs.
   */
  private writeToExtension(raw: string): void {
    this.stdout.write(encodeFrame(raw));
  }

  private onExtensionEnd(): void {
    this.opts.onExtensionDisconnect?.();
    void this.close();
  }

  private fail(error: Error): void {
    this.opts.onError?.(error);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True only when connecting reports nothing bound to this path — the one answer that makes
 * deleting the file safe. A live backend accepts; a non-socket file fails as something other
 * than ECONNREFUSED; a path we cannot probe in time is assumed live.
 */
function isUnbound(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (unbound: boolean) => {
      if (timer) clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(unbound);
    };
    timer = setTimeout(() => settle(false), STALE_PROBE_TIMEOUT_MS);
    socket.once("connect", () => settle(false));
    socket.once("error", (error: NodeJS.ErrnoException) => settle(error.code === "ECONNREFUSED"));
  });
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
