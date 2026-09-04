import { NodeReplHost, type NodeReplContextHandlers } from "./NodeReplHost.ts";
import { randomUUID } from "node:crypto";
import type { ComputerUseIntegration } from "./integration.ts";
import type { CodexTurnMetadata, EmittedImage } from "./ipc.ts";
import type { NodeReplConfigStore } from "./configStore.ts";

export interface NodeReplSessionOptions {
  /** Socket path of the operon-computer-use Swift service, injected as
   *  nodeRepl.env.SKY_CUA_NATIVE_PIPE_PATH. */
  socketPath: string;
  /** Host integration for elicitation, output, images and launching. Safe
   *  defaults apply when omitted. */
  integration?: ComputerUseIntegration;
  /** Raw requestMeta, passed through. Turn metadata belongs in
   *  `run(code, turnMetadata)` instead. */
  requestMeta?: Record<string, unknown>;
  /**
   * Extra variables merged into `nodeRepl.env` alongside
   * `SKY_CUA_NATIVE_PIPE_PATH`; these win on a name clash.
   *
   * Browser Use uses it to inject `OPERON_BROWSER_USE_BUILD_FLAVOR`, so a
   * packaged and a development backend sharing one discovery directory cannot
   * connect to each other by mistake.
   */
  env?: Record<string, string>;
  /**
   * Injected into the kernel *process*'s `process.env`, invisible to the model.
   * The import allowlist reads it:
   * `NODE_REPL_TRUSTED_CODE_PATHS` / `NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S` /
   * `NODE_REPL_TRUST_ALL_CODE`. Do not put these in `env`, which the model reads.
   */
  processEnv?: Record<string, string>;
  /** `nodeRepl.tmpDir`; defaults to os.tmpdir(). */
  tmpDir?: string;
  /** Backend for `nodeRepl.config`: browser security policy and approval memory.
   *  Without it the user is asked every time. */
  configStore?: NodeReplConfigStore;
  kernelEntry?: string;
  execArgv?: string[];
  /**
   * Startup token for the CU socket. When set, the host sends an authentication
   * frame before anything else on connecting to this session's `socketPath`.
   * createComputerUse injects the engine's authToken automatically, so passing
   * it by hand is rarely needed.
   */
  cuAuthToken?: string;
  /**
   * Runtime setup executed once per kernel, before the model's first `run`.
   * See banner.ts for what it contains and why the model no longer writes it.
   *
   * It runs as its own `exec`, not spliced into the model's cell: a failure is
   * then attributable to setup rather than to the model's code, and a later
   * throw from the model's own code cannot un-run it.
   */
  banner?: string;
  /**
   * A kernel to share instead of forking one.
   *
   * A kernel process costs ~63 MB and ~115 ms to start, while the vm context
   * this session actually needs costs ~0.2 MB and ~190 µs. Passing a shared host
   * therefore turns "one process per conversation" into "one process, a context
   * each" without weakening the isolation that matters: contexts do not share
   * `globalThis`, so one conversation still cannot see another's variables.
   *
   * Omit it and the session forks a kernel of its own, which is what a direct
   * embedding or a test wants.
   */
  host?: NodeReplHost | (() => NodeReplHost);
}

export interface NodeReplRunResult {
  result: unknown;
  output: string;
  images: EmittedImage[];
  responseMeta: Record<string, unknown>;
}

/**
 * One persistent node_repl session, corresponding to a single task or
 * conversation.
 *
 * The same kernel keeps `globalThis` across calls, so globals and variables
 * survive. write and emitImage accumulate into the result of the current call
 * while also streaming to the host integration. The core depends on no tool
 * framework.
 */
export class NodeReplSession {
  private host: NodeReplHost | null = null;
  /** True when this session forked the kernel and must therefore kill it. A
   *  shared one outlives the session and is only asked to drop its context. */
  private ownsHost = false;
  /** This session's vm context inside the kernel. */
  private readonly ctx = randomUUID();
  /** In-flight context creation, so two concurrent `run`s do not both build one. */
  private starting: Promise<NodeReplHost> | null = null;
  private output = "";
  private images: NodeReplRunResult["images"] = [];
  /** Per-kernel, not per-session: `reset()` drops the kernel, so the banner has
   *  to run again against the new one. */
  private bannerExecuted = false;

  private readonly opts: NodeReplSessionOptions;

  // No parameter properties (`constructor(private readonly opts…)`). Vite treats
  // this package as external, so Node loads the .ts source directly with
  // strip-only type erasure, and a parameter property raises
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. See the external list in vite.config.ts.
  constructor(opts: NodeReplSessionOptions) {
    this.opts = opts;
  }

  private async ensureHost(): Promise<NodeReplHost> {
    // A dead kernel is dropped rather than reused. With a shared one this is the
    // recovery path: the provider hands back a fresh process and this session
    // rebuilds its context in it, instead of every conversation staying broken
    // until the app restarts.
    if (this.host?.alive) return this.host;
    this.host = null;
    return (this.starting ??= this.startContext().finally(() => {
      this.starting = null;
    }));
  }

  /**
   * Per-conversation callbacks. They are registered with the context rather than
   * the host: on a shared kernel the host serves every conversation, and a
   * `write` has to come back to this one.
   */
  private buildHandlers(): NodeReplContextHandlers {
    const integration = this.opts.integration;
    return {
      onWrite: (t) => {
        this.output += t;
        integration?.onOutput?.(t);
      },
      onImage: (img) => {
        this.images.push(img);
        integration?.onImage?.(img);
      },
      onElicitation: integration?.requestElicitation,
      launchApplication: integration?.launchApplication,
    };
  }

  private async startContext(): Promise<NodeReplHost> {
    const provided = typeof this.opts.host === "function" ? this.opts.host() : this.opts.host;
    const host = provided ?? new NodeReplHost({
      env: { SKY_CUA_NATIVE_PIPE_PATH: this.opts.socketPath, ...this.opts.env },
      requestMeta: this.opts.requestMeta,
      tmpDir: this.opts.tmpDir,
      processEnv: this.opts.processEnv,
      configStore: this.opts.configStore,
      kernelEntry: this.opts.kernelEntry,
      execArgv: this.opts.execArgv,
      cuAuthToken: this.opts.cuAuthToken,
      cuSocketPath: this.opts.socketPath,
    });
    this.ownsHost = provided == null;
    await host.createContext(this.ctx, this.buildHandlers());
    this.host = host;
    return host;
  }

  /**
   * Run a piece of model code and return its completion value, along with the
   * text and images accumulated during this call.
   *
   * `turnMetadata` is this turn's metadata, and has to be passed every turn: the
   * kernel outlives a turn, so omitting it leaves the previous turn_id in place.
   * - The browser client requires session_id and turn_id, and throws on its very
   *   first call without them.
   * - The Computer Use client tolerates their absence and sends null, which the
   *   server accepts, so a Computer-Use-only integration can skip it.
   */
  async run(code: string, turnMetadata?: CodexTurnMetadata): Promise<NodeReplRunResult> {
    const host = await this.ensureHost();
    if (turnMetadata) host.setTurnMetadata(this.ctx, turnMetadata, this.opts.requestMeta);
    const bannerOutput = await this.ensureBanner(host);
    this.output = "";
    this.images = [];
    const result = await host.exec(this.ctx, code);
    return {
      result,
      // Setup diagnostics ride in front of the model's own output rather than
      // being dropped: they are the only signal that a surface is missing.
      output: bannerOutput + this.output,
      images: this.images,
      responseMeta: host.responseMetaFor(this.ctx),
    };
  }

  /**
   * Install the runtime once per kernel. Returns whatever the banner wrote,
   * which is empty on the happy path.
   *
   * A throwing banner is reported and then forgiven. It means a host-side path
   * is missing, not that the model asked for anything wrong, and the call may
   * well not need the surface that failed — refusing to run the model's code
   * would turn a one-surface problem into a dead session.
   */
  private async ensureBanner(host: NodeReplHost): Promise<string> {
    const banner = this.opts.banner?.trim();
    if (!banner || this.bannerExecuted) return "";
    this.bannerExecuted = true;
    this.output = "";
    this.images = [];
    try {
      await host.exec(this.ctx, banner);
    } catch (e) {
      return `node_repl runtime setup failed: ${e instanceof Error ? e.message : String(e)}\n`;
    }
    return this.output;
  }

  /**
   * Discard this conversation's JavaScript world. Its globals and variables go
   * with it, and the next `run` replays the banner into a fresh context.
   *
   * Browser tabs and native apps are untouched: they live in the backends, not
   * in this process, and the model is told as much in the tool description.
   */
  async reset(): Promise<void> {
    this.bannerExecuted = false;
    this.output = "";
    this.images = [];
    const host = this.host;
    if (!host) return;
    // Rebuild the context on the same kernel rather than replacing the kernel.
    // On a shared one that is the whole point — resetting one conversation must
    // not disturb the others — and it costs microseconds instead of a ~115 ms
    // fork even when the kernel is this session's own.
    await host.disposeContext(this.ctx).catch(() => {});
    await host.createContext(this.ctx, this.buildHandlers());
  }

  async dispose(): Promise<void> {
    const host = this.host;
    this.host = null;
    this.bannerExecuted = false;
    if (!host) return;
    await host.disposeContext(this.ctx).catch(() => {});
    // Only kill the process if this session started it. A shared kernel serves
    // other conversations and outlives every one of them.
    if (this.ownsHost) await host.dispose();
  }
}
