/**
 * AppServerClient - manages the codex app-server process and JSON-RPC communication
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { logProviderRaw } from '../../../provider-raw-log.js';
import type {
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCError,
  JSONRPCNotification,
  InitializeParams,
  InitializeResult,
  ThreadStartParams,
  ThreadStartResult,
  ThreadForkParams,
  ThreadInjectItemsParams,
  ThreadResumeParams,
  TurnStartParams,
  TurnStartResult,
  TurnInterruptParams,
  ModelListParams,
  ModelListResult,
  SkillListParams,
  SkillListResult,
  GoalSetParams,
  GoalGetParams,
  GoalClearParams,
  GoalResult,
  GoalClearResult,
} from './protocol/index.js';
import type { CodexAppServerSettings, Logger } from './types/index.js';

type PendingRequest = {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type NotificationHandler = (params: unknown) => void;

/**
 * Returned by a request handler that does not own this request — typically
 * because the request belongs to a different thread. The client then offers it
 * to the next handler, and finally to the fallback handlers.
 *
 * A distinct sentinel rather than `null`/`undefined`, both of which are valid
 * JSON-RPC results a handler may legitimately want to answer with.
 */
export const REQUEST_NOT_HANDLED = Symbol('codex.request-not-handled');

// Handler for server-initiated requests (expects a response). Return
// REQUEST_NOT_HANDLED to pass the request on to the next handler.
type RequestHandler = (
  params: unknown,
  id: string | number,
) => Promise<unknown | typeof REQUEST_NOT_HANDLED> | unknown | typeof REQUEST_NOT_HANDLED;

const DEFAULT_REQUEST_TIMEOUT = 60_000; // 60 seconds
const DESKTOP_CLIENT_NAME = 'Codex Desktop';
const DESKTOP_CLIENT_VERSION = '26.324.21641';
const DESKTOP_SERVICE_NAME = 'codex_desktop';
const DESKTOP_ORIGINATOR = 'Codex Desktop';

/**
 * Client for communicating with the codex app-server process
 */
export class AppServerClient {
  private process: ChildProcess | null = null;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private notificationHandlers = new Map<string, Set<NotificationHandler>>();
  /**
   * Server-initiated request handlers, in registration order. One app-server can
   * carry many threads at once, so a method may have several owners — each is
   * offered the request until one claims it (see {@link REQUEST_NOT_HANDLED}).
   */
  private requestHandlers = new Map<string, RequestHandler[]>();
  /** Tried after every ordinary handler has declined. */
  private fallbackRequestHandlers = new Map<string, RequestHandler[]>();
  /**
   * Threads this connection forked as ephemeral — they exist only in this
   * process's memory, so they are gone the moment it is. Lets a caller tell
   * "my thread is still here" from "the server that held it has been replaced",
   * which a thread id alone cannot answer.
   */
  private ephemeralThreads = new Set<string>();
  private initialized = false;
  private starting: Promise<void> | null = null;
  private logger: Logger;

  constructor(private settings: CodexAppServerSettings) {
    this.logger = this.createLogger();
  }

  private resolveCodexCommand(): { cmd: string; args: string[] } {
    const codexPath = this.settings.codexPath ?? 'codex';
    const lower = codexPath.toLowerCase();
    if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
      return { cmd: process.execPath, args: [codexPath] };
    }
    return { cmd: codexPath, args: [] };
  }

  private createLogger(): Logger {
    if (this.settings.logger === false) {
      return {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      };
    }

    if (this.settings.logger) {
      return this.settings.logger;
    }

    const verbose = this.settings.verbose ?? false;
    return {
      debug: verbose ? (msg) => console.debug(`[codex-app-server] ${msg}`) : () => {},
      info: verbose ? (msg) => console.info(`[codex-app-server] ${msg}`) : () => {},
      warn: (msg) => console.warn(`[codex-app-server] ${msg}`),
      error: (msg) => console.error(`[codex-app-server] ${msg}`),
    };
  }

  /**
   * Ensure the app-server process is started and initialized
   */
  async ensureStarted(): Promise<void> {
    if (this.initialized) return;

    if (this.starting) {
      await this.starting;
      return;
    }

    this.starting = this.start();
    await this.starting;
  }

  private async start(): Promise<void> {
    const { cmd, args } = this.resolveCodexCommand();

    this.logger.info(`Starting codex app-server: ${cmd} ${[...args, 'app-server'].join(' ')}`);

    this.process = spawn(cmd, [...args, 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...this.settings.env,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: DESKTOP_ORIGINATOR,
      },
      cwd: this.settings.cwd,
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error('Failed to spawn codex app-server: no stdio');
    }

    // Set up line-delimited JSON parsing on stdout
    const rl = createInterface({ input: this.process.stdout });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as JSONRPCResponse | JSONRPCError | JSONRPCNotification;
        logProviderRaw('codex', msg);
        this.handleMessage(msg);
      } catch (err) {
        this.logger.error(`Failed to parse JSON line: ${line}`);
      }
    });

    // Capture stderr for debugging
    if (this.process.stderr) {
      const stderrRl = createInterface({ input: this.process.stderr });
      stderrRl.on('line', (line) => {
        this.logger.debug(`[stderr] ${line}`);
      });
    }

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      this.logger.info(`codex app-server exited with code ${code}, signal ${signal}`);
      this.cleanup();
    });

    this.process.on('error', (err) => {
      this.logger.error(`codex app-server process error: ${err.message}`);
      this.cleanup();
    });

    // Perform initialization handshake (direct send to avoid recursion)
    const initParams: InitializeParams = {
      clientInfo: {
        name: DESKTOP_CLIENT_NAME,
        title: DESKTOP_CLIENT_NAME,
        version: DESKTOP_CLIENT_VERSION,
      },
      capabilities: {
        experimentalApi: true,
      },
    };

    await this.sendRequest<InitializeResult>('initialize', initParams);
    this.notify('initialized', {});
    this.initialized = true;

    this.logger.info('codex app-server initialized');
  }

  /**
   * Send a request without checking ensureStarted (for internal use during init)
   */
  private sendRequest<T>(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT): Promise<T> {
    const id = randomUUID();
    const message: JSONRPCRequest = { id, method };
    if (params !== undefined) {
      message.params = params as Record<string, unknown>;
    }

    this.logger.debug(`Request ${id}: ${method}`);

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      this.send(message);
    });
  }

  private cleanup(): void {
    this.initialized = false;
    this.starting = null;
    this.process = null;
    // Ephemeral threads died with the process, whether it exited or crashed.
    this.ephemeralThreads.clear();

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('App server connection closed'));
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  async request<T>(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT): Promise<T> {
    await this.ensureStarted();
    return this.sendRequest<T>(method, params, timeoutMs);
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  notify(method: string, params?: unknown): void {
    if (!this.process?.stdin) {
      this.logger.warn(`Cannot send notification ${method}: process not started`);
      return;
    }

    const message: JSONRPCNotification = { method };
    if (params !== undefined) {
      message.params = params as Record<string, unknown>;
    }

    this.logger.debug(`Notification: ${method}`);
    this.send(message);
  }

  private send(message: JSONRPCRequest | JSONRPCNotification): void {
    if (!this.process?.stdin) {
      throw new Error('Cannot send: process not started');
    }

    const line = JSON.stringify(message) + '\n';
    this.process.stdin.write(line);
  }

  private handleMessage(msg: JSONRPCResponse | JSONRPCError | JSONRPCNotification | JSONRPCRequest): void {
    const hasId = 'id' in msg && msg.id !== undefined;
    const hasMethod = 'method' in msg && msg.method !== undefined;

    // Case 1: Response to our pending request (has id, no method, or has id and is in pendingRequests)
    if (hasId && !hasMethod) {
      this.handleResponse(msg as JSONRPCResponse | JSONRPCError);
      return;
    }

    // Case 2: Server-initiated Request (has both id and method, not in our pendingRequests)
    if (hasId && hasMethod) {
      const typedMsg = msg as JSONRPCRequest;
      // Check if this is actually a response we're waiting for (shouldn't happen, but be safe)
      if (this.pendingRequests.has(typedMsg.id!)) {
        this.handleResponse(msg as JSONRPCResponse | JSONRPCError);
        return;
      }
      // This is a server-initiated request
      this.handleServerRequest(typedMsg);
      return;
    }

    // Case 3: Notification (has method, no id)
    if (hasMethod && !hasId) {
      this.handleNotification(msg as JSONRPCNotification);
    }
  }

  private handleResponse(msg: JSONRPCResponse | JSONRPCError): void {
    const pending = this.pendingRequests.get(msg.id!);
    if (!pending) {
      this.logger.warn(`Received response for unknown request id: ${msg.id}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(msg.id!);

    if ('error' in msg && msg.error) {
      this.logger.debug(`Response ${msg.id} (${pending.method}): error - ${msg.error.message}`);
      pending.reject(new Error(msg.error.message));
    } else if ('result' in msg) {
      this.logger.debug(`Response ${msg.id} (${pending.method}): success`);
      pending.resolve(msg.result);
    }
  }

  private handleServerRequest(msg: JSONRPCRequest): void {
    this.logger.debug(`Server request received: ${msg.method} (id: ${msg.id})`);

    const candidates = [
      ...(this.requestHandlers.get(msg.method) ?? []),
      ...(this.fallbackRequestHandlers.get(msg.method) ?? []),
    ];
    if (candidates.length === 0) {
      this.logger.warn(`No handler registered for server request: ${msg.method}`);
      // Send error response
      this.sendResponse(msg.id!, undefined, {
        code: -32601,
        message: `Method not found: ${msg.method}`,
      });
      return;
    }

    // Offer the request to each handler until one claims it. Handlers that
    // belong to another thread decline, which is what keeps one shared
    // app-server from answering a conversation with another's policy.
    void (async () => {
      try {
        for (const handler of candidates) {
          const result = await handler(msg.params, msg.id!);
          if (result === REQUEST_NOT_HANDLED) continue;
          this.sendResponse(msg.id!, result);
          return;
        }
        // Every handler declined: the thread this belongs to has no live owner.
        const threadId = (msg.params as { threadId?: unknown } | undefined)?.threadId;
        this.logger.warn(
          `No handler claimed server request ${msg.method} (threadId: ${String(threadId)})`,
        );
        this.sendResponse(msg.id!, undefined, {
          code: -32000,
          message: `No live handler for ${msg.method}`,
        });
      } catch (err) {
        this.logger.error(`Handler error for ${msg.method}: ${err}`);
        this.sendResponse(msg.id!, undefined, {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  private handleNotification(msg: JSONRPCNotification): void {
    if (msg.method === 'mcpServer/startupStatus/updated') {
      this.logger.debug(
        `Notification received: ${msg.method} ${JSON.stringify(msg.params)}`,
      );
    } else {
      this.logger.debug(`Notification received: ${msg.method}`);
    }
    const handlers = this.notificationHandlers.get(msg.method);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(msg.params);
        } catch (err) {
          this.logger.error(`Notification handler error for ${msg.method}: ${err}`);
        }
      }
    }
  }

  private sendResponse(id: string | number, result?: unknown, error?: { code: number; message: string }): void {
    if (!this.process?.stdin) {
      this.logger.warn(`Cannot send response: process not started`);
      return;
    }

    const response: JSONRPCResponse | JSONRPCError = error
      ? { id, error }
      : { id, result: result ?? null };

    const line = JSON.stringify(response) + '\n';
    this.process.stdin.write(line);
    this.logger.debug(`Sent response for ${id}: ${error ? 'error' : 'success'}`);
  }

  /** Record a thread that lives only in this process (see {@link ephemeralThreads}). */
  markEphemeralThread(threadId: string): void {
    this.ephemeralThreads.add(threadId);
  }

  /** Whether this connection is still the one holding `threadId`. */
  hasEphemeralThread(threadId: string): boolean {
    return this.ephemeralThreads.has(threadId);
  }

  /**
   * Subscribe to server notifications
   * @returns Unsubscribe function
   */
  onNotification(method: string, handler: NotificationHandler): () => void {
    if (!this.notificationHandlers.has(method)) {
      this.notificationHandlers.set(method, new Set());
    }
    this.notificationHandlers.get(method)!.add(handler);

    return () => {
      this.notificationHandlers.get(method)?.delete(handler);
    };
  }

  /**
   * Register a handler for server-initiated requests (requires a response).
   *
   * Several handlers may share a method — one app-server carries every thread,
   * so each live turn registers its own. They are offered the request in
   * registration order and should return {@link REQUEST_NOT_HANDLED} for a
   * thread that is not theirs; `fallback` handlers are tried only after all the
   * others have declined.
   *
   * @returns Unregister function
   */
  onRequest(
    method: string,
    handler: RequestHandler,
    options?: { fallback?: boolean },
  ): () => void {
    const registry = options?.fallback ? this.fallbackRequestHandlers : this.requestHandlers;
    const handlers = registry.get(method) ?? [];
    handlers.push(handler);
    registry.set(method, handlers);

    return () => {
      const current = registry.get(method);
      if (!current) return;
      const index = current.indexOf(handler);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) registry.delete(method);
    };
  }

  // ============ High-level API Methods ============

  /**
   * Start a new thread
   */
  async startThread(params: ThreadStartParams): Promise<ThreadStartResult> {
    return this.request<ThreadStartResult>('thread/start', {
      ...params,
      serviceName: params.serviceName ?? DESKTOP_SERVICE_NAME,
    });
  }

  /**
   * Resume an existing thread
   */
  async resumeThread(params: ThreadResumeParams): Promise<ThreadStartResult> {
    return this.request<ThreadStartResult>('thread/resume', params);
  }

  /**
   * Branch a thread. The fork inherits the source thread's history as model
   * context; pass `excludeTurns` to keep the app server from replaying that
   * history back to us (see {@link ThreadForkParams}).
   */
  async forkThread(params: ThreadForkParams): Promise<ThreadStartResult> {
    return this.request<ThreadStartResult>('thread/fork', params);
  }

  /**
   * Append items to a thread's history without running a turn.
   */
  async injectItems(params: ThreadInjectItemsParams): Promise<void> {
    await this.request<unknown>('thread/inject_items', params);
  }

  /**
   * Start a turn on a thread
   */
  async startTurn(params: TurnStartParams): Promise<TurnStartResult> {
    return this.request<TurnStartResult>('turn/start', params);
  }

  /**
   * Interrupt an active turn
   */
  async interruptTurn(params: TurnInterruptParams): Promise<void> {
    await this.request<void>('turn/interrupt', params);
  }

  /**
   * List available models
   */
  async listModels(params?: ModelListParams): Promise<ModelListResult> {
    return this.request<ModelListResult>('model/list', params ?? {});
  }

  /**
   * List available skills
   */
  async listSkills(params?: SkillListParams): Promise<SkillListResult> {
    return this.request<SkillListResult>('skills/list', params ?? {});
  }

  /**
   * Set (or continue) a thread goal. Setting status:'active' makes codex
   * autonomously start one turn toward the objective.
   */
  async setGoal(params: GoalSetParams): Promise<GoalResult> {
    return this.request<GoalResult>('thread/goal/set', params);
  }

  /**
   * Get the current thread goal.
   */
  async getGoal(params: GoalGetParams): Promise<GoalResult> {
    return this.request<GoalResult>('thread/goal/get', params);
  }

  /**
   * Clear the thread goal.
   */
  async clearGoal(params: GoalClearParams): Promise<GoalClearResult> {
    return this.request<GoalClearResult>('thread/goal/clear', params);
  }

  /**
   * Dispose of the client and kill the process
   */
  dispose(): void {
    if (this.process) {
      this.logger.info('Disposing codex app-server client');
      this.process.kill('SIGTERM');
      this.cleanup();
    }
  }
}
