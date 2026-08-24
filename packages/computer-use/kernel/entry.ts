import vm from "node:vm";
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

const init: KernelInit = JSON.parse(
  process.env.OPERON_NODE_REPL_INIT ?? '{"env":{},"requestMeta":{}}',
);

let reqSeq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const send: SendRequest = (method: PrivilegedMethod, params: unknown) => {
  const id = ++reqSeq;
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send!({ kind: "req", id, method, params });
  });
};

const {
  nodeRepl,
  untrustedNodeRepl,
  dispatchConnectionEvent,
  setRequestMeta,
  runAfterSubmittedCodeHooks,
} =
  createNodeReplFacade(send, init);

// Trusted modules run in the kernel realm once imported, and read the *full*
// nodeRepl from here, nativePipe included. Model code cannot reach it: it lives
// in the vm sandbox and gets `untrustedNodeRepl` below. This is the split
// between the trusted and untrusted realms.
(globalThis as unknown as { nodeRepl?: unknown }).nodeRepl = nodeRepl;

// ---- The persistent vm context; globals survive across exec calls ----
const sandbox: Record<string, unknown> = {};
vm.createContext(sandbox, { name: "node-repl" });

const fmt = (x: unknown) => (typeof x === "string" ? x : safeStringify(x));
const consoleShim = {
  log: (...a: unknown[]) => nodeRepl.write(a.map(fmt).join(" ") + "\n"),
  info: (...a: unknown[]) => nodeRepl.write(a.map(fmt).join(" ") + "\n"),
  warn: (...a: unknown[]) => nodeRepl.write(a.map(fmt).join(" ") + "\n"),
  error: (...a: unknown[]) => nodeRepl.write(a.map(fmt).join(" ") + "\n"),
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

async function exec(id: number, code: string) {
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
    const value = await script.runInContext(sandbox);
    await runAfterSubmittedCodeHooks();
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
      void exec(msg.id, msg.code);
      break;
    case "setRequestMeta":
      setRequestMeta(msg.requestMeta);
      break;
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
void (async () => {
  try {
    const mod = await import("../computer/index.ts");
    sandbox.computer = mod.computer;
  } catch (e) {
    // A load failure must not block the runtime; the model gets a clear error
    // when it calls `computer`.
    sandbox.__computerLoadError = e instanceof Error ? (e.stack ?? e.message) : String(e);
  } finally {
    process.send!({ kind: "ready" });
  }
})();
