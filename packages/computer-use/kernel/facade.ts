import { Buffer } from "node:buffer";
import os from "node:os";
import type { EmittedImage, KernelInit, PrivilegedMethod } from "../ipc.ts";

/** The channel the kernel uses to send privileged requests to the host. */
export type SendRequest = (method: PrivilegedMethod, params: unknown) => Promise<unknown>;

interface ConnectionHandlers {
  data: Array<(buf: Buffer) => void>;
  error: Array<(err: Error) => void>;
  close: Array<() => void>;
}

/**
 * Builds the `globalThis.nodeRepl` façade injected into the vm context.
 *
 * Every privileged method here does the same thing: hand the request to the
 * host, which holds the socket and the permissions. The kernel never gets a raw
 * handle to anything.
 *
 * The Computer Use client depends on: nativePipe.createConnection,
 * launchServices.openApplication, createElicitation, setResponseMeta,
 * withSuspendedTimeout, write, env and requestMeta.
 *
 * The browser client additionally reads tmpDir, homeDir and cwd, plus an
 * optional telemetry hook. They are not equally optional:
 *
 * - `tmpDir` is required. It is read as
 *   `"nodeRepl" in globalThis && globalThis.nodeRepl ? globalThis.nodeRepl.tmpDir : <fallback>`,
 *   so the ternary tests whether *nodeRepl* exists, not whether tmpDir does.
 *   Since we do set nodeRepl, omitting tmpDir yields undefined rather than the
 *   fallback.
 * - `homeDir` degrades to `os.homedir()`, but is passed anyway so that paths
 *   derived from it resolve under the home directory we intend.
 * - `cwd` degrades to null.
 * - `telemetry` is optional throughout (`?.startSpan(...)` falling back to a
 *   no-op span). We have no telemetry backend and deliberately provide nothing:
 *   supplying `undefined` is equivalent to omitting it, and inventing an API
 *   that does nothing would be a lie.
 */
export function createNodeReplFacade(send: SendRequest, init: KernelInit) {
  const connections = new Map<string, ConnectionHandlers>();
  const afterSubmittedCodeHooks = new Set<{
    run(): Promise<void> | void;
    timeoutMs?: number;
  }>();

  const nativePipe = {
    async createConnection(path: string) {
      const { connectionId } = (await send("nativePipe.connect", { path })) as {
        connectionId: string;
      };
      const handlers: ConnectionHandlers = { data: [], error: [], close: [] };
      connections.set(connectionId, handlers);
      return {
        on(event: "data" | "error" | "close", cb: (arg?: unknown) => void) {
          (handlers[event] as Array<(arg?: unknown) => void>).push(cb);
          return this;
        },
        write(bytes: Uint8Array | Buffer | string) {
          const buf = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
          void send("nativePipe.write", { connectionId, dataBase64: buf.toString("base64") });
        },
        end() {
          void send("nativePipe.close", { connectionId });
        },
      };
    },
  };

  /** Socket events travelling host to kernel are dispatched here to the listeners
 *  of the matching connection. */
  function dispatchConnectionEvent(evt: {
    event: "nativePipe.data" | "nativePipe.closed";
    connectionId: string;
    dataBase64?: string;
    error?: string;
  }) {
    const h = connections.get(evt.connectionId);
    if (!h) return;
    if (evt.event === "nativePipe.data" && evt.dataBase64 != null) {
      const buf = Buffer.from(evt.dataBase64, "base64");
      for (const cb of h.data) cb(buf);
    } else if (evt.event === "nativePipe.closed") {
      if (evt.error) for (const cb of h.error) cb(new Error(evt.error));
      for (const cb of h.close) cb();
      connections.delete(evt.connectionId);
    }
  }

  const nodeRepl = {
    nativePipe,
    launchServices: {
      openApplication: (target: unknown) => send("launchServices.openApplication", { target }),
    },
    createElicitation: (request: { message: string; meta?: unknown }) =>
      send("createElicitation", request),
    withSuspendedTimeout: async <T>(fn: () => Promise<T> | T): Promise<T> => {
      if (typeof fn !== "function") throw new Error("nodeRepl.withSuspendedTimeout expected a function");
      return await fn();
    },
    setResponseMeta: (meta: unknown) => {
      void send("setResponseMeta", { meta });
    },
    addAfterSubmittedCodeHook: (hook: {
      run(): Promise<void> | void;
      timeoutMs?: number;
    }) => {
      if (hook == null || typeof hook.run !== "function") {
        throw new Error("nodeRepl.addAfterSubmittedCodeHook expected a run function");
      }
      afterSubmittedCodeHooks.add(hook);
      return () => afterSubmittedCodeHooks.delete(hook);
    },
    emitImage: (image: unknown) => send("emitImage", normalizeImage(image)),
    write: (text: string) => {
      void send("write", { text: String(text) });
    },
    env: init.env,
    /** Refreshed by the host each turn through `setRequestMeta`; see its note below. */
    requestMeta: init.requestMeta,
    // Browser client dependencies; see the note above on which are required.
    tmpDir: init.tmpDir ?? os.tmpdir(),
    homeDir: os.homedir(),
    cwd: process.cwd(),

    /**
     * Storage backend for browser security policy and remembered approvals.
     * Without it, `goto()` simply does not work.
     *
     * The browser client decides whether it is running inside a node repl by
     * looking at `config`, and at nothing else: a nodeRepl whose `config` is
     * null is treated as absent entirely. The consent gate for cross-origin
     * navigation then cannot find `createElicitation` and throws
     * "Browser security unavailable outside node repl". Our createElicitation is
     * right there and it does not help, for the same reason as the `tmpDir`
     * trap above: the check tests a different field. (`title()` and `url()` do
     * not cross origins, so they keep working, which makes this easy to
     * misdiagnose.)
     *
     * What the four methods are for:
     * - `readRequirements()` returns administrator-level (MDM) policy, shaped
     *   `{requirements:{network:{…}}}`.
     * - `read({cwd, includeLayers})` returns user config; the client reads
     *   `default_permissions` from it and resolves
     *   `permissions[profile].network` into allowed and denied domains.
     * - `readToml(path)` and `writeToml(path, obj)` are the approval memory
     *   behind "don't ask me again". The path is *relative* and computed by the
     *   caller (`browser/config.toml` for global scope,
     *   `browser/sessions/<conversationId>.toml` for a single session), which
     *   means the host owns the root. Ours is `~/.operon/`.
     *
     * These must fail closed. The calling code wraps the whole policy lookup in
     * `try { … } catch { return "deny" }`, so throwing from any of these methods
     * denies the navigation. A host with no store configured has to return an
     * empty object rather than throw.
     *
     * Exposed on the kernel realm only, never to untrusted code: this is the
     * ability to read and write files on the user's disk.
     */
    config: {
      readRequirements: () => send("config.readRequirements", {}),
      read: (opts?: unknown) => send("config.read", opts ?? {}),
      readToml: (path: string) => send("config.readToml", { path }),
      writeToml: (path: string, value: unknown) => send("config.writeToml", { path, value }),
    },
  };

  /**
   * Replace `nodeRepl.requestMeta`. The host calls this once per turn.
   *
   * It has to be mutable: the kernel outlives a single turn while `turn_id`
   * changes every turn, and KernelInit is baked into the env at fork time, so
   * relying on that alone would freeze turn_id at the first turn. Callers re-read
   * `nodeRepl.requestMeta` on every call, so replacing the object wholesale is
   * enough for the next read to see it.
   */
  const setRequestMeta = (requestMeta: Record<string, unknown>) => {
    nodeRepl.requestMeta = requestMeta;
    untrusted.requestMeta = requestMeta;
  };

  /**
   * The restricted façade model code sees.
   *
   * The kernel runs two realms and injects a *different* `nodeRepl` into each:
   * the untrusted realm, where model code runs, gets this reduced object, while
   * the trusted realm gets the full one. Both realms have a `nodeRepl`; they are
   * simply not the same object. (It is tempting to assume only the trusted realm
   * has one at all. It does not work that way.)
   *
   * Three capabilities are withheld from model code:
   *
   * - `nativePipe` would connect directly to `/tmp/operon-browser-use/*.sock` and
   *   the Computer Use socket, bypassing every check the backend performs.
   * - `launchServices` would launch applications on the machine.
   * - `config` would read and write configuration files on the user's disk,
   *   which means model code could add a site to its own allowlist and walk
   *   straight through the consent gate.
   *
   * Trusted modules read the full object from the kernel realm's `globalThis`
   * and are unaffected: they are `import`ed, so they run in the kernel realm
   * rather than inside the vm sandbox.
   */
  const untrusted: Record<string, unknown> = {
    createElicitation: nodeRepl.createElicitation,
    withSuspendedTimeout: nodeRepl.withSuspendedTimeout,
    setResponseMeta: nodeRepl.setResponseMeta,
    emitImage: nodeRepl.emitImage,
    write: nodeRepl.write,
    env: init.env,
    requestMeta: init.requestMeta,
    tmpDir: init.tmpDir ?? os.tmpdir(),
    homeDir: os.homedir(),
    cwd: process.cwd(),
  };

  const runAfterSubmittedCodeHooks = async (): Promise<void> => {
    for (const hook of afterSubmittedCodeHooks) {
      try {
        const run = Promise.resolve().then(() => hook.run());
        if (hook.timeoutMs == null) {
          await run;
          continue;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            run,
            new Promise<void>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("after-submitted-code hook timed out")),
                hook.timeoutMs,
              );
            }),
          ]);
        } finally {
          if (timer != null) clearTimeout(timer);
        }
      } catch {
        // A presentation hook must never turn successful model code into a tool error.
      }
    }
  };

  return {
    nodeRepl,
    untrustedNodeRepl: untrusted,
    dispatchConnectionEvent,
    setRequestMeta,
    runAfterSubmittedCodeHooks,
  };
}

function normalizeImage(image: unknown): EmittedImage {
  if (typeof image === "string") return normalizeImageUrl(image);

  if (image && typeof image === "object") {
    if ("image_url" in image) {
      return normalizeImageUrl(String((image as { image_url: unknown }).image_url));
    }
    if ("bytes" in image) {
      const input = image as { bytes: unknown; mimeType?: unknown };
      const mimeType =
        typeof input.mimeType === "string" && input.mimeType.trim() !== ""
          ? input.mimeType
          : undefined;
      return normalizeImageBytes(input.bytes, mimeType);
    }
  }

  return normalizeImageBytes(image);
}

function normalizeImageUrl(url: string): EmittedImage {
  const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(url);
  if (dataUrl) {
    return { mimeType: dataUrl[1], dataBase64: dataUrl[2] };
  }
  return { url };
}

function normalizeImageBytes(bytes: unknown, mimeType?: string): EmittedImage {
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : bytes instanceof Uint8Array
      ? Buffer.from(bytes)
      : null;
  if (!buf) {
    throw new Error(
      "nodeRepl.emitImage expected a URL, bytes, { image_url }, or { bytes, mimeType }",
    );
  }
  return { mimeType: mimeType ?? inferMime(buf), dataBase64: buf.toString("base64") };
}

function inferMime(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";
  throw new Error("nodeRepl.emitImage could not infer MIME (expected PNG/JPEG/WebP)");
}
