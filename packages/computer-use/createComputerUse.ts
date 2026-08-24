import { ComputerUseService, type ComputerUseServiceOptions } from "./ComputerUseService.ts";
import { NodeReplSession } from "./NodeReplSession.ts";
import type { ComputerUseIntegration } from "./integration.ts";
import { createNodeReplTool, type NodeReplTool } from "./adapters/tool.ts";
import type { NodeReplConfigStore } from "./configStore.ts";

export interface CreateComputerUseOptions {
  /** Host integration: elicitation to authorize, output and images to the chat
   *  stream, plus launching. */
  integration?: ComputerUseIntegration;
  /** Swift service options, and whether to start it automatically (it does by default). */
  service?: ComputerUseServiceOptions & { autoStart?: boolean };
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
   * Override the token used to authenticate against the CU socket. It defaults to
   * the `authToken` of the service this factory started itself. node-repl-mcp
   * passes the *shared* engine's token instead: it uses `autoStart:false` so the
   * factory starts nothing, and the service it manages separately is the one
   * actually enforcing the token, so the two have to be aligned explicitly.
   */
  cuAuthToken?: string;
}

export interface ComputerUseHandle {
  service: ComputerUseService;
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
  const service = new ComputerUseService(opts.service);
  if (opts.service?.autoStart !== false) await service.start();

  // Token for CU socket authentication: this service's own by default, overridden
  // by node-repl-mcp with the shared engine's.
  const cuAuthToken = opts.cuAuthToken ?? service.authToken;

  const sessions: NodeReplSession[] = [];
  const createSession = () => {
    const session = new NodeReplSession({
      socketPath: service.socketPath,
      integration: opts.integration,
      kernelEntry: opts.kernelEntry,
      execArgv: opts.execArgv,
      env: opts.env,
      processEnv: opts.processEnv,
      configStore: opts.configStore,
      cuAuthToken,
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
