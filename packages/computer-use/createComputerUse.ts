import { CuaDriverService, type CuaDriverServiceOptions } from "./CuaDriverService.ts";
import { NodeReplSession } from "./NodeReplSession.ts";
import { CUA_DRIVER_SOCKET_ENV } from "./computer/backend.ts";
import type { ComputerUseIntegration } from "./integration.ts";
import { createNodeReplTool, type NodeReplTool } from "./adapters/tool.ts";
import type { NodeReplConfigStore } from "./configStore.ts";

export interface CreateComputerUseOptions {
  /** Host integration: elicitation to authorize, output and images to the chat
   *  stream, plus launching. */
  integration?: ComputerUseIntegration;
  /** cua-driver daemon options, and whether to start it automatically (it does
   *  by default). */
  driver?: CuaDriverServiceOptions & { autoStart?: boolean };
  kernelEntry?: string;
  execArgv?: string[];
  /**
   * Extra variables merged into `nodeRepl.env`. Browser Use injects
   * `OPERON_BROWSER_USE_BUILD_FLAVOR` through it to tell a packaged backend apart
   * from a development one.
   */
  env?: Record<string, string>;
  /**
   * Injected into the kernel *process*'s `process.env`, invisible to the model.
   * The import allowlist reads it:
   * `NODE_REPL_TRUSTED_CODE_PATHS` / `NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S` /
   * `NODE_REPL_TRUST_ALL_CODE`. See assertTrustedImport in kernel/entry.ts.
   */
  processEnv?: Record<string, string>;
  /**
   * Backend for `nodeRepl.config`: browser security policy and the approval
   * memory behind "don't ask me about this site again". Without one,
   * noopConfigStore applies and every cross-origin navigation asks the user.
   * See configStore.ts.
   */
  configStore?: NodeReplConfigStore;
  /**
   * Runtime setup run once per kernel before the model's first line of code.
   * Build it with `buildNodeReplBanner(surfaces)`; omitting it leaves the model
   * to bootstrap the runtime by hand, which is what the skills used to teach.
   */
  banner?: string;
  /**
   * A kernel process to share instead of forking one per session. Pass a getter
   * so a kernel that died can be replaced without rebuilding this handle.
   * See NodeReplSessionOptions.host for why sharing is safe.
   */
  host?: import("./NodeReplHost.ts").NodeReplHost | (() => import("./NodeReplHost.ts").NodeReplHost);
}

export interface ComputerUseHandle {
  service: CuaDriverService;
  /** Create a persistent node_repl session, normally one per conversation. */
  createSession(): NodeReplSession;
  /** Convenience: the `mcp__node_repl__js` tool over the default session, via the
   *  zod adapter. */
  tool: NodeReplTool;
  dispose(): Promise<void>;
}

/**
 * Top-level factory that bootstraps the whole module in one line. The
 * recommended entry point for any framework:
 *
 *   const cu = await createComputerUse({
 *     integration: { requestElicitation: myAuthorize, onOutput: (t) => stream.write(t) },
 *   });
 *   myFramework.registerTool(cu.tool);   // or wrap cu.createSession() yourself
 *   // …
 *   await cu.dispose();
 */
export async function createComputerUse(
  opts: CreateComputerUseOptions = {},
): Promise<ComputerUseHandle> {
  const service = new CuaDriverService(opts.driver);
  if (opts.driver?.autoStart !== false) await service.start();

  const sessions: NodeReplSession[] = [];
  const createSession = () => {
    const session = new NodeReplSession({
      socketPath: service.socketPath,
      integration: opts.integration,
      kernelEntry: opts.kernelEntry,
      execArgv: opts.execArgv,
      // `selectBackend()` reads this to find the daemon. Callers that pass their
      // own `host` set it on that kernel instead; this covers the self-forked case.
      env: { [CUA_DRIVER_SOCKET_ENV]: service.socketPath, ...opts.env },
      processEnv: opts.processEnv,
      configStore: opts.configStore,
      banner: opts.banner,
      host: opts.host,
    });
    sessions.push(session);
    return session;
  };

  const defaultSession = createSession();

  return {
    service,
    createSession,
    tool: createNodeReplTool(defaultSession),
    async dispose() {
      for (const session of sessions) await session.dispose();
      await service.stop();
    },
  };
}
