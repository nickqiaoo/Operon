import { NodeReplHost } from "./NodeReplHost.ts";
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
  private output = "";
  private images: NodeReplRunResult["images"] = [];

  private readonly opts: NodeReplSessionOptions;

  // No parameter properties (`constructor(private readonly opts…)`). Vite treats
  // this package as external, so Node loads the .ts source directly with
  // strip-only type erasure, and a parameter property raises
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. See the external list in vite.config.ts.
  constructor(opts: NodeReplSessionOptions) {
    this.opts = opts;
  }

  private ensureHost(): NodeReplHost {
    if (!this.host) {
      const integration = this.opts.integration;
      this.host = new NodeReplHost({
        env: { SKY_CUA_NATIVE_PIPE_PATH: this.opts.socketPath, ...this.opts.env },
        requestMeta: this.opts.requestMeta,
        tmpDir: this.opts.tmpDir,
        processEnv: this.opts.processEnv,
        configStore: this.opts.configStore,
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
        kernelEntry: this.opts.kernelEntry,
        execArgv: this.opts.execArgv,
        cuAuthToken: this.opts.cuAuthToken,
        cuSocketPath: this.opts.socketPath,
      });
    }
    return this.host;
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
    const host = this.ensureHost();
    if (turnMetadata) host.setTurnMetadata(turnMetadata, this.opts.requestMeta);
    this.output = "";
    this.images = [];
    const result = await host.exec(code);
    return {
      result,
      output: this.output,
      images: this.images,
      responseMeta: { ...host.responseMeta },
    };
  }

  async dispose(): Promise<void> {
    await this.host?.dispose();
    this.host = null;
  }
}
