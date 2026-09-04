import vm from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import { formatNodeReplError } from "../error-format.ts";
import path from "node:path";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createNodeReplFacade, type SendRequest } from "./facade.ts";
import type { HostToKernel, KernelInit, PrivilegedMethod } from "../ipc.ts";

// Entry point for the kernel child process: model code runs inside a
// vm.createContext soft sandbox. Anything privileged goes to the host over IPC.
// `process` is denied outright and never injected into the sandbox.
//
// ## One process, many contexts
//
// This process serves every conversation, with a vm context each. What is
// expensive is the process — ~63 MB and ~115 ms of fork plus tsx — while a vm
// context is ~0.2 MB and ~190 µs, so the isolation that matters (a separate
// `globalThis` per conversation) is nearly free once the process is up.
//
// The catch is that trusted modules are cached per process. The browser SDK is
// one module instance shared by every context, and it finds its session through
// `globalThis.nodeRepl`. So the single trusted façade has to resolve per call,
// which is what the AsyncLocalStorage below is for: `send` tags each outbound
// request with the context that made it, and `requestMeta` reads the context
// currently executing.
//
// Codex solves the same problem the same way (its kernel.js carries an
// "AsyncLocalStorage keeps the current tool-call state available" note), but it
// stops at one kernel per process: its kernel is spawned inside an OS sandbox
// bound to one conversation's cwd and permission profile, so a second context
// would still need a second process. We have no OS sandbox on the kernel, so
// the process boundary carries no isolation we would lose by sharing it.

const init: KernelInit = JSON.parse(
  process.env.OPERON_NODE_REPL_INIT ?? '{"env":{},"requestMeta":{}}',
);

let reqSeq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** One conversation's JavaScript world. */
interface ContextState {
  id: string;
  /** The vm context. `globalThis` for the model code running in it. */
  sandbox: Record<string, unknown>;
  /** Turn metadata for this context, replaced by the host every turn. */
  requestMeta: Record<string, unknown>;
}

const contexts = new Map<string, ContextState>();

/**
 * The context currently executing.
 *
 * Every privileged call funnels through `send`, and every trusted module reads
 * its session through `requestMeta`, so this one store is what keeps N
 * conversations from being attributed to each other. It propagates across
 * `await` on its own; the places it does not reach are callbacks invoked from
 * outside an execution, which is why the façade captures and re-enters a scope
 * for socket handlers.
 */
const currentCtx = new AsyncLocalStorage<ContextState>();

/**
 * Fallback context id for a request raised with no execution in progress.
 *
 * It should not happen — the façade re-enters a scope for socket events — but a
 * request that reaches the host with no route is worse than one that lands on a
 * named dead letter the host can log.
 */
const ORPHAN_CTX = "__orphan__";

const send: SendRequest = (method: PrivilegedMethod, params: unknown) => {
  const id = ++reqSeq;
  const ctx = currentCtx.getStore()?.id ?? ORPHAN_CTX;
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send!({ kind: "req", id, ctx, method, params });
  });
};

const {
  nodeRepl,
  untrustedNodeRepl,
  dispatchConnectionEvent,
  forgetConnectionsInScope,
  runAfterSubmittedCodeHooks,
} = createNodeReplFacade(send, init, {
  requestMetaFor: () => currentCtx.getStore()?.requestMeta ?? init.requestMeta,
  // The scope token is the ContextState itself, so re-entering it restores
  // exactly the store `send` and `requestMeta` read.
  captureScope: () => currentCtx.getStore(),
  runInScope: (scope, fn) => (scope ? currentCtx.run(scope as ContextState, fn) : fn()),
});

// Trusted modules run in the kernel realm once imported, and read the *full*
// nodeRepl from here, nativePipe included. Model code cannot reach it: it lives
// in the vm sandbox and gets `untrustedNodeRepl` below. This is the split
// between the trusted and untrusted realms.
(globalThis as unknown as { nodeRepl?: unknown }).nodeRepl = nodeRepl;

// ---- One persistent vm context per conversation; globals survive across execs ----

const fmt = (x: unknown) => (typeof x === "string" ? x : safeStringify(x));

/**
 * Build a conversation's JavaScript world.
 *
 * Everything here is per context: its own `globalThis`, so one conversation's
 * variables are invisible to another. What is deliberately *not* per context is
 * the façade — `untrustedNodeRepl` is shared, because each of its methods
 * resolves the caller through AsyncLocalStorage rather than through a closure
 * over one conversation.
 */
function createContext(id: string): ContextState {
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox, { name: `node-repl:${id}` });

  const write = (a: unknown[]) => nodeRepl.write(a.map(fmt).join(" ") + "\n");
  const consoleShim = {
    log: (...a: unknown[]) => write(a),
    info: (...a: unknown[]) => write(a),
    warn: (...a: unknown[]) => write(a),
    error: (...a: unknown[]) => write(a),
  };

  Object.assign(sandbox, {
    // Model code gets the restricted object: no nativePipe, no launchServices.
    // The full one exists only on the kernel realm's globalThis, for trusted
    // modules that were imported (see above).
    nodeRepl: untrustedNodeRepl,
    Buffer,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console: consoleShim,
    // `process` and `require` are deliberately not injected (§3.2 denies process;
    // a gated `require` is still outstanding).
  });

  // This global used to have a different name. A bare ReferenceError tells the
  // model nothing, and its context may still carry skill text using the old name,
  // so raise an error it can correct itself from rather than keeping the old name
  // alive.
  Object.defineProperty(sandbox, "sky", {
    configurable: true,
    get() {
      throw new Error(
        "`sky` no longer exists — Operon's Computer Use client is `computer` "
          + "(e.g. computer.get_app_state({ app: \"Safari\" })).",
      );
    },
  });

  applyComputerClient(sandbox);

  const state: ContextState = { id, sandbox, requestMeta: init.requestMeta };
  contexts.set(id, state);
  return state;
}

/**
 * Drop a context. Its globals go with it, and so do the sockets it opened —
 * a closed conversation must not leave data handlers behind in a process that
 * outlives it.
 */
function disposeContext(id: string): void {
  const state = contexts.get(id);
  if (!state) return;
  contexts.delete(id);
  const orphaned = forgetConnectionsInScope(state);
  if (orphaned.length > 0) {
    currentCtx.run(state, () => {
      for (const connectionId of orphaned) void send("nativePipe.close", { connectionId });
    });
  }
}

/**
 * The import allowlist: the second line of defence after the sandbox itself.
 *
 * A module is trusted if any one of three things holds: its sha256 appears in
 * `NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S`, its path sits under one of the
 * absolute directories in `NODE_REPL_TRUSTED_CODE_PATHS`, or
 * `NODE_REPL_TRUST_ALL_CODE` is set to "1".
 *
 * With none of the three set, only `node:` builtins are allowed. That
 * conservative default is deliberate:
 * with no statement from the host, model code must not be able to import
 * arbitrary code from disk into the kernel realm.
 */
const trustedSha256s = new Set(
  (process.env.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const trustedDirs = (process.env.NODE_REPL_TRUSTED_CODE_PATHS ?? "")
  .split(path.delimiter)
  .filter((p) => p.length > 0 && path.isAbsolute(p))
  .map((p) => path.resolve(p));
const trustAllImportedCode = process.env.NODE_REPL_TRUST_ALL_CODE === "1";

function assertTrustedImport(specifier: string): void {
  if (trustAllImportedCode) return;
  // A `node:` builtin has no code on disk, so there is nothing untrusted to inject.
  if (specifier.startsWith("node:")) return;

  let file: string;
  try {
    file = specifier.startsWith("file:") ? fileURLToPath(specifier) : path.resolve(specifier);
  } catch {
    throw new Error(`node_repl: refusing to import untrusted module "${specifier}"`);
  }
  // A bare specifier such as "lodash" resolves to no absolute path and is always
  // refused: it would pull arbitrary code out of node_modules.
  if (!path.isAbsolute(file) || !existsSync(file)) {
    throw new Error(
      `node_repl: refusing to import "${specifier}" — only node: builtins and trusted paths are importable`,
    );
  }
  if (trustedDirs.some((dir) => file === dir || file.startsWith(dir + path.sep))) return;
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (trustedSha256s.has(sha)) return;
  throw new Error(
    `node_repl: refusing to import untrusted module ${file} (sha256 ${sha.slice(0, 12)}…). ` +
      `Add it to NODE_REPL_TRUSTED_CODE_PATHS or NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S.`,
  );
}

async function exec(id: number, ctxId: string, code: string) {
  const state = contexts.get(ctxId);
  if (!state) {
    process.send!({
      kind: "execResult",
      id,
      ok: false,
      error: `node_repl: unknown context "${ctxId}"`,
    });
    return;
  }
  try {
    const src = `(async () => {\n${code}\n})()`;
    const script = new vm.Script(src, {
      filename: "node-repl.js",
      // `import(x)` in model code lands here: check the allowlist first, then let
      // the kernel perform the import itself.
      //
      // A callback rather than `USE_MAIN_CONTEXT_DEFAULT_LOADER`: that constant
      // goes straight to the default loader with nowhere to put a gate. Rewriting
      // the source is not an option either, since a regex would also hit
      // "import(" inside strings and comments, and a security gate cannot ship
      // with a known way around it.
      //
      // The `import()` inside the callback yields a real module running in the
      // kernel realm, which is exactly the semantics the browser client needs: it
      // reads its own `../docs/` and loads a native classic-level build, both of
      // which a hand-rolled loader would break.
      importModuleDynamically: (async (specifier: string) => {
        assertTrustedImport(specifier);
        return await import(specifier);
      }) as unknown as vm.ScriptOptions["importModuleDynamically"],
    });
    // Everything downstream — `send`, `requestMeta`, socket scopes — reads the
    // store this establishes. It survives the awaits inside model code.
    const value = await currentCtx.run(state, async () => {
      const v = await script.runInContext(state.sandbox);
      await runAfterSubmittedCodeHooks(state);
      return v;
    });
    process.send!({ kind: "execResult", id, ok: true, result: value });
  } catch (e) {
    process.send!({
      kind: "execResult",
      id,
      ok: false,
      error: formatNodeReplError(e),
    });
  }
}

process.on("message", (msg: HostToKernel) => {
  switch (msg.kind) {
    case "res": {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "host error"));
      break;
    }
    case "event":
      dispatchConnectionEvent(msg);
      break;
    case "exec":
      void exec(msg.id, msg.ctx, msg.code);
      break;
    case "createContext": {
      if (!contexts.has(msg.ctx)) createContext(msg.ctx);
      process.send!({ kind: "execResult", id: msg.id, ok: true });
      break;
    }
    case "disposeContext": {
      disposeContext(msg.ctx);
      process.send!({ kind: "execResult", id: msg.id, ok: true });
      break;
    }
    case "setRequestMeta": {
      const state = contexts.get(msg.ctx);
      if (state) state.requestMeta = msg.requestMeta;
      break;
    }
  }
});

function safeStringify(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

// Preload the Mac window client and inject it into the vm sandbox so the model
// can call `computer.*`. The skill's bootstrap check
// `if (!globalThis.computer) {...}` short-circuits as a result.
//
// Since 2026-07-17 this is our own `../computer/` implementation rather than a
// vendored bundle. The reason was legal, not aesthetic: the vendored package is
// proprietary and its NOTICE forbids redistributing it with a product. Our
// implementation was validated frame by frame against the reference
// (sky-differential: 50 frames, zero differences, matching return
// values), and the vendored copy is kept only as a test oracle, never on the
// product path.
//
// Note the client runs in the kernel realm, here, and reads the full nodeRepl
// from globalThis, nativePipe included. Model code sits in the vm sandbox with
// the restricted object. That privilege split does not loosen just because the
// code became ours.
/**
 * The Mac window client, loaded once for the whole process and injected into
 * every context as `computer`.
 *
 * Loading it per context would be waste, not safety: it is a stateless façade
 * over the shared Swift engine and reads its session from `requestMeta`, which
 * already resolves per context.
 *
 * Note the client runs in the kernel realm, here, and reads the full nodeRepl
 * from globalThis, nativePipe included. Model code sits in the vm sandbox with
 * the restricted object. That privilege split does not loosen just because the
 * code became ours.
 *
 * Since 2026-07-17 this is our own `../computer/` implementation rather than a
 * vendored bundle. The reason was legal, not aesthetic: the vendored package is
 * proprietary and its NOTICE forbids redistributing it with a product. Our
 * implementation was validated frame by frame against the reference
 * (sky-differential: 50 frames, zero differences, matching return values), and
 * the vendored copy is kept only as a test oracle, never on the product path.
 */
let computerClient: unknown;
let computerLoadError: string | undefined;

/** Give one context its `computer`, or the reason it has none. A load failure
 *  must not block the runtime; the model gets a clear error when it calls it. */
function applyComputerClient(sandbox: Record<string, unknown>): void {
  if (computerLoadError != null) sandbox.__computerLoadError = computerLoadError;
  else sandbox.computer = computerClient;
}

void (async () => {
  try {
    const mod = await import("../computer/index.ts");
    computerClient = mod.computer;
  } catch (e) {
    computerLoadError = e instanceof Error ? (e.stack ?? e.message) : String(e);
  } finally {
    // The host waits for this before creating any context, so every context
    // built afterwards sees a settled client.
    process.send!({ kind: "ready" });
  }
})();
