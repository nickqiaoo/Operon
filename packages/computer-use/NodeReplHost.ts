import { fork, type ChildProcess } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import type { HostToKernel, KernelInit, CodexTurnMetadata, EmittedImage } from "./ipc.ts";
import { CODEX_TURN_METADATA_HEADER } from "./ipc.ts";
import { encodeAuthFrame } from "./computer/wire.ts";
import { noopConfigStore, type NodeReplConfigStore } from "./configStore.ts";

export interface ElicitationResult {
  action: "accept" | "cancel" | "decline";
  content?: unknown;
  _meta?: unknown;
}

/**
 * The parts of a host that belong to one conversation rather than to the
 * process. Everything else — the import allowlist, `nodeRepl.env`, the config
 * store, the sockets — is identical for every context and stays on the host.
 */
export interface NodeReplContextHandlers {
  /** Text callback for nodeRepl.write, wired into one chat's stream. */
  onWrite?: (text: string) => void;
  /** Callback for nodeRepl.emitImage. */
  onImage?: (img: EmittedImage) => void;
  /** Routes nodeRepl.createElicitation to that chat's authorize flow. */
  onElicitation?: (req: { message: string; meta?: unknown }) => Promise<ElicitationResult>;
  /** nodeRepl.launchServices.openApplication */
  launchApplication?: (target: unknown) => Promise<void>;
}

export interface NodeReplHostOptions {
  /** Injected as the kernel's `nodeRepl.env` (e.g. SKY_CUA_NATIVE_PIPE_PATH).
   *  Visible to the model. This is not the process env. */
  env?: Record<string, string>;
  /**
   * Injected into the kernel *process*'s `process.env`. The model cannot see it:
   * there is no `process` inside the sandbox.
   *
   * The distinction from `env` matters: `env` is `nodeRepl.env`, which the model
   * reads. This is the kernel's own process environment, and it is where the
   * import allowlist (`NODE_REPL_TRUSTED_CODE_PATHS`,
   * `NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S`, `NODE_REPL_TRUST_ALL_CODE`) is
   * read from. Put those in `env` instead and the model can read them while the
   * allowlist has no effect at all.
   */
  processEnv?: Record<string, string>;
  /**
   * Turn metadata. The browser client requires both session_id and turn_id: without
   * them its very first call throws "Missing required browser session_id". The
   * Computer Use client tolerates their absence. This is a typed entry point so
   * callers do not have to hardcode the metadata key.
   */
  turnMetadata?: CodexTurnMetadata;
  /** Raw requestMeta, passed through. When given alongside turnMetadata, the
   *  latter wins on conflicting keys. */
  requestMeta?: Record<string, unknown>;
  cwd?: string;
  /** `nodeRepl.tmpDir`, defaulting to os.tmpdir(). It must have a value: callers
   *  read it without a fallback of their own. */
  tmpDir?: string;
  /** Text callback for nodeRepl.write, wired into the operon chat stream. */
  onWrite?: (text: string) => void;
  /** Callback for nodeRepl.emitImage. */
  onImage?: (img: EmittedImage) => void;
  /** Routes nodeRepl.createElicitation to operon's authorize flow (§11.5).
   *  Defaults to accepting when not provided. */
  onElicitation?: (req: { message: string; meta?: unknown }) => Promise<ElicitationResult>;
  /** nodeRepl.launchServices.openApplication */
  launchApplication?: (target: unknown) => Promise<void>;
  /**
   * Backend for `nodeRepl.config`: browser security policy plus approval memory.
   *
   * Omitting it means asking the user on every cross-origin navigation, because
   * noopConfigStore cannot remember a choice. Product integrations should pass
   * `createTomlConfigStore()`. Note that `config` itself must always be present
   * on the façade, or the client concludes it is not running in a node repl and
   * `goto()` throws. What is optional here is the *store*, not the config.
   */
  configStore?: NodeReplConfigStore;
  /** Kernel entry point. Defaults to ./kernel/entry.ts; production can point at
   *  a bundled .mjs instead. */
  kernelEntry?: string;
  /**
   * execArgv for the fork. Defaults to tsx (for the TypeScript entry) plus
   * `--experimental-vm-modules`. A bundled production build can drop tsx, but
   * `--experimental-vm-modules` has to stay; see DEFAULT_EXEC_ARGV.
   */
  execArgv?: string[];
  /**
   * Startup token for the CU socket, held host-side. When set, and when the
   * kernel asks to connect to `path === cuSocketPath`, the host sends one
   * `operon/authenticate` frame after connecting and before any request. The
   * token stays in-process: it never goes through env and never enters the
   * kernel sandbox. See the authentication note in computer/wire.ts.
   */
  cuAuthToken?: string | (() => string | undefined);
  /** The CU socket path that requires authentication. Gated together with
   *  {@link cuAuthToken} so the browser-use socket is never sent auth frames. */
  cuSocketPath?: string;
}

function defaultKernelEntry(): string {
  return fileURLToPath(new URL("./kernel/entry.ts", import.meta.url));
}

/**
 * Fork arguments for the kernel.
 *
 * - `--import tsx`, because the kernel entry point is TypeScript.
 * - `--experimental-vm-modules`, which the import allowlist depends on. A vm has
 *   two ways to provide dynamic import:
 *     - `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`, a symbol that needs no
 *       flag but leaves nowhere to put a gate;
 *     - a custom callback, which can hold a gate but throws without the flag:
 *       `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG`。
 *   The gate is not optional here, because an imported module runs in the kernel
 *   realm and can reach the full nodeRepl. So the callback it is. See
 *   `assertTrustedImport` in kernel/entry.ts.
 */
const DEFAULT_EXEC_ARGV = ["--import", "tsx", "--experimental-vm-modules"];

/**
 * The host side of the node_repl runtime: the parent process that holds the
 * privileges. It spawns the kernel child process and keeps sockets, launching
 * and elicitation to itself; the kernel only sends messages (§3).
 */
export class NodeReplHost {
  private readonly child: ChildProcess;
  private readonly ready: Promise<void>;
  private execSeq = 0;
  private readonly execPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly sockets = new Map<string, net.Socket>();
  private connSeq = 0;
  private disposed = false;
  private readonly opts: NodeReplHostOptions;
  /**
   * The conversations this kernel is serving.
   *
   * One process, a vm context each. A `write` or an elicitation arrives tagged
   * with its context so it reaches the right chat; without that tag a shared
   * kernel would post one conversation's output into another.
   */
  /** Rejects `ready` when the kernel dies before announcing itself. */
  private onReadyFailed: (e: Error) => void = () => {};
  private exitReason: string | undefined;
  private readonly contexts = new Map<
    string,
    { handlers: NodeReplContextHandlers; responseMeta: Record<string, unknown> }
  >();

  constructor(opts: NodeReplHostOptions = {}) {
    this.opts = opts;
    const init: KernelInit = {
      env: opts.env ?? {},
      requestMeta: {
        ...opts.requestMeta,
        ...(opts.turnMetadata ? { [CODEX_TURN_METADATA_HEADER]: opts.turnMetadata } : {}),
      },
      tmpDir: opts.tmpDir,
    };
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // Nothing may await `ready` forever: a kernel that dies during startup
    // (a missing tsx, a bad entry path) would otherwise wedge every caller.
    this.ready.catch(() => {});
    this.onReadyFailed = readyReject;
    this.child = fork(opts.kernelEntry ?? defaultKernelEntry(), [], {
      cwd: opts.cwd ?? process.cwd(),
      execArgv: opts.execArgv ?? DEFAULT_EXEC_ARGV,
      env: { ...process.env, ...opts.processEnv, OPERON_NODE_REPL_INIT: JSON.stringify(init) },
      // stdout is ignored: stray output from the kernel must not corrupt whatever
      // is above us, above all the stdout channel of a stdio MCP server.
      // stderr is inherited for debugging. fd3 carries the IPC control channel.
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    // A kernel that dies takes every in-flight call with it. Rejecting them with
    // a clear reason beats leaving them pending forever — and on a shared kernel
    // "forever" would mean every conversation at once.
    this.child.once("exit", (code, signal) => {
      this.handleChildExit(
        `node_repl kernel exited unexpectedly (${signal ? `signal=${signal}` : `code=${code ?? "unknown"}`})`,
      );
    });
    this.child.on("message", (msg: { kind: string } & Record<string, unknown>) => {
      if (msg.kind === "ready") readyResolve();
      else if (msg.kind === "req") void this.handleRequest(msg as unknown as { id: number; method: string; params: unknown });
      else if (msg.kind === "execResult") this.onExecResult(msg as unknown as { id: number; ok: boolean; result?: unknown; error?: string });
    });
  }

  /**
   * Refresh the kernel's `nodeRepl.requestMeta`. Call this once per turn.
   *
   * The kernel outlives a turn while `turn_id` changes every turn, and KernelInit
   * was baked into the env at fork time. Without this refresh turn_id freezes at
   * the first turn and the browser client works against a stale one.
   */
  private onExecResult(msg: { id: number; ok: boolean; result?: unknown; error?: string }) {
    const p = this.execPending.get(msg.id);
    if (!p) return;
    this.execPending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "exec failed"));
  }

  /** Safe send: silently drops once the kernel has exited or been disposed,
   *  which avoids EPIPE. */
  private post(msg: HostToKernel) {
    if (this.disposed || !this.child.connected) return;
    try {
      this.child.send(msg);
    } catch {
      /* Channel already gone; ignore. */
    }
  }

  /**
   * Whether this kernel can still serve calls.
   *
   * A shared kernel is held by a getter rather than by reference precisely so a
   * dead one can be replaced; this is what the getter checks.
   */
  get alive(): boolean {
    return !this.disposed && this.exitReason == null && this.child.connected;
  }

  private handleChildExit(reason: string): void {
    if (this.exitReason != null) return;
    this.exitReason = reason;
    this.onReadyFailed(new Error(reason));
    const error = new Error(reason);
    for (const p of this.execPending.values()) p.reject(error);
    this.execPending.clear();
    for (const p of this.pendingHostRequests()) p.reject(error);
    this.contexts.clear();
    for (const s of this.sockets.values()) {
      s.removeAllListeners();
      s.destroy();
    }
    this.sockets.clear();
  }

  /** No host-side request map exists today; kept as a seam so a future one is
   *  cleaned up here too rather than being forgotten. */
  private pendingHostRequests(): Array<{ reject: (e: Error) => void }> {
    return [];
  }

  private respond(id: number, ok: boolean, result?: unknown, error?: string) {
    this.post({ kind: "res", id, ok, result, error });
  }

  private event(
    event: "nativePipe.data" | "nativePipe.closed",
    connectionId: string,
    extra: { dataBase64?: string; error?: string } = {},
  ) {
    this.post({ kind: "event", event, connectionId, ...extra });
  }

  private async handleRequest(msg: { id: number; ctx?: string; method: string; params: unknown }) {
    try {
      this.respond(msg.id, true, await this.privileged(msg.ctx, msg.method, msg.params));
    } catch (e) {
      this.respond(msg.id, false, undefined, e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Per-conversation callbacks, falling back to the constructor's.
   *
   * The fallback is what keeps a single-context embedding working unchanged:
   * pass `onWrite` to the constructor and one context still finds it. A shared
   * host registers its handlers per context instead and passes none here.
   */
  private handlers(ctx: string | undefined): NodeReplContextHandlers {
    const registered = ctx != null ? this.contexts.get(ctx)?.handlers : undefined;
    return registered ?? this.opts;
  }

  private async privileged(ctx: string | undefined, method: string, params: unknown): Promise<unknown> {
    const p = params as Record<string, unknown>;
    const handlers = this.handlers(ctx);
    switch (method) {
      case "nativePipe.connect": {
        const connectionId = `c${this.connSeq++}`;
        const socket = net.connect({ path: String(p.path) });
        this.sockets.set(connectionId, socket);
        socket.on("data", (buf: Buffer) =>
          this.event("nativePipe.data", connectionId, { dataBase64: buf.toString("base64") }),
        );
        socket.on("close", () => {
          this.sockets.delete(connectionId);
          this.event("nativePipe.closed", connectionId);
        });
        socket.on("error", (e: Error) => this.event("nativePipe.closed", connectionId, { error: e.message }));
        await once(socket, "connect");
        // The authentication frame specific to the CU socket, sent after
        // connecting and before any request, ping included. It has to be gated by
        // path: this same host also connects to browser-use's
        // `/tmp/operon-browser-use/*.sock`, and an auth frame there would corrupt
        // that protocol. Both token and path are host-side constructor arguments.
        // This method runs in the host process, not the kernel sandbox, and
        // neither value ever reaches the model-visible nodeRepl.env.
        // Resolved at connect time, not at construction: a shared kernel outlives
        // the Computer Use engine, and a restarted engine issues a new token.
        const cuAuthToken = typeof this.opts.cuAuthToken === "function"
          ? this.opts.cuAuthToken()
          : this.opts.cuAuthToken;
        if (cuAuthToken && String(p.path) === this.opts.cuSocketPath) {
          socket.write(encodeAuthFrame(cuAuthToken));
        }
        return { connectionId };
      }
      case "nativePipe.write":
        this.sockets.get(String(p.connectionId))?.write(Buffer.from(String(p.dataBase64), "base64"));
        return {};
      case "nativePipe.close":
        this.sockets.get(String(p.connectionId))?.end();
        return {};
      case "launchServices.openApplication":
        await handlers.launchApplication?.(p.target);
        return {};
      case "createElicitation":
        return handlers.onElicitation
          ? await handlers.onElicitation(p as { message: string; meta?: unknown })
          : { action: "accept" };
      case "setResponseMeta": {
        const entry = ctx != null ? this.contexts.get(ctx) : undefined;
        if (entry) entry.responseMeta = { ...entry.responseMeta, ...(p.meta as object) };
        return {};
      }
      case "emitImage":
        handlers.onImage?.(p as EmittedImage);
        return {};
      case "write":
        handlers.onWrite?.(String(p.text));
        return {};
      // ---- nodeRepl.config: browser security policy and approval memory
      //      (see configStore.ts) ----
      // With no store configured this falls back to noopConfigStore rather than
      // throwing. The policy lookup fails closed, so throwing here would deny
      // the navigation outright.
      case "config.readRequirements":
        return await (this.opts.configStore ?? noopConfigStore).readRequirements();
      case "config.read":
        return await (this.opts.configStore ?? noopConfigStore).read(
          p as { cwd?: string | null; includeLayers?: boolean },
        );
      case "config.readToml":
        return await (this.opts.configStore ?? noopConfigStore).readToml(String(p.path));
      case "config.writeToml":
        await (this.opts.configStore ?? noopConfigStore).writeToml(String(p.path), p.value);
        return {};
      default:
        throw new Error(`unknown privileged method: ${method}`);
    }
  }

  /**
   * Register a conversation and build its vm context in the kernel.
   *
   * Idempotent: re-registering an id replaces the handlers, which is what a
   * reconnecting MCP transport needs.
   */
  async createContext(ctx: string, handlers: NodeReplContextHandlers = {}): Promise<void> {
    await this.ready;
    this.contexts.set(ctx, { handlers, responseMeta: {} });
    await this.control({ kind: "createContext", ctx });
  }

  /** Drop a conversation's context. The process and every other context live on. */
  async disposeContext(ctx: string): Promise<void> {
    if (!this.contexts.delete(ctx)) return;
    if (this.disposed || !this.child.connected) return;
    await this.control({ kind: "disposeContext", ctx }).catch(() => {});
  }

  /** How many conversations this kernel is serving. */
  get contextCount(): number {
    return this.contexts.size;
  }

  /** Response metadata accumulated by one context's last exec. */
  responseMetaFor(ctx: string): Record<string, unknown> {
    return { ...(this.contexts.get(ctx)?.responseMeta ?? {}) };
  }

  /** A control message that the kernel acknowledges through the exec channel. */
  private control(msg: { kind: "createContext" | "disposeContext"; ctx: string }): Promise<unknown> {
    const id = ++this.execSeq;
    return new Promise<unknown>((resolve, reject) => {
      this.execPending.set(id, { resolve, reject });
      this.child.send({ ...msg, id } satisfies HostToKernel);
    });
  }

  setTurnMetadata(
    ctx: string,
    turnMetadata: CodexTurnMetadata,
    extraRequestMeta?: Record<string, unknown>,
  ) {
    this.post({
      kind: "setRequestMeta",
      ctx,
      requestMeta: {
        ...this.opts.requestMeta,
        ...extraRequestMeta,
        [CODEX_TURN_METADATA_HEADER]: turnMetadata,
      },
    });
  }

  /** Run a piece of model code in one conversation's context and return its
   *  completion value. */
  async exec(ctx: string, code: string): Promise<unknown> {
    await this.ready;
    const entry = this.contexts.get(ctx);
    if (entry) entry.responseMeta = {};
    const id = ++this.execSeq;
    return new Promise<unknown>((resolve, reject) => {
      this.execPending.set(id, { resolve, reject });
      this.child.send({ kind: "exec", id, ctx, code } satisfies HostToKernel);
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const s of this.sockets.values()) {
      s.removeAllListeners();
      s.destroy();
    }
    this.sockets.clear();
    this.child.kill();
  }
}
