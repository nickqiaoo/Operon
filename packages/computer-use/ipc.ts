// The IPC message protocol between the host (the agent-runtime parent process)
// and the kernel (its child).
//
// The kernel holds no raw system handles. Every privileged operation, whether
// connecting a socket, launching an app or asking a person, is sent to the host
// as a message and performed there. Socket bytes always cross the boundary as
// base64.

/**
 * kernel to host: a privileged request that expects a response.
 *
 * `ctx` names the vm context the request came from. One kernel process serves
 * many of them (one per conversation), and the host has different handlers for
 * each — a `write` has to reach the right chat, an elicitation the right
 * approval dialog — so every request carries its origin.
 */
export interface KernelRequest {
  kind: "req";
  id: number;
  ctx: string;
  method: PrivilegedMethod;
  params: unknown;
}

export type PrivilegedMethod =
  | "nativePipe.connect" // params {path} → {connectionId}
  | "nativePipe.write" // params {connectionId, dataBase64}
  | "nativePipe.close" // params {connectionId}
  | "launchServices.openApplication" // params {target}
  | "createElicitation" // params {message, meta} → {action, content?, _meta?}
  | "setResponseMeta" // params {meta}
  | "emitImage" // params {mimeType?, dataBase64?, url?}
  | "write" // params {text}
  // ---- nodeRepl.config: the store behind browser security policy and approval
  //      memory (see the config comment in facade.ts) ----
  // File IO is privileged, so it goes through the host exactly as nativePipe does.
  | "config.readRequirements" // params {} -> administrator policy {requirements?:{network?:…}}
  | "config.read" // params {cwd, includeLayers} -> user config (permissions profile)
  | "config.readToml" // params {path} -> the parsed object; path is relative to the root
  | "config.writeToml"; // params {path, value}

/** An image from `nodeRepl.emitImage(...)`, normalised for transport between
 *  kernel and host. */
export interface EmittedImage {
  mimeType?: string;
  dataBase64?: string;
  url?: string;
}

/** kernel to host: the result of one execution. `id` is unique across contexts,
 *  so the host routes on it alone. */
export interface KernelExecResult {
  kind: "execResult";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type KernelToHost = KernelRequest | KernelExecResult;

/** host to kernel: the response to a KernelRequest. */
export interface HostResponse {
  kind: "res";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** host to kernel: a socket event (data or closed). */
export interface HostEvent {
  kind: "event";
  event: "nativePipe.data" | "nativePipe.closed";
  connectionId: string;
  dataBase64?: string;
  error?: string;
}

/** host to kernel: create a vm context. Idempotent; the kernel replies "ready"
 *  for the id so the host can await it. */
export interface HostCreateContext {
  kind: "createContext";
  id: number;
  ctx: string;
}

/** host to kernel: drop a vm context and everything in it. The globals and any
 *  sockets it opened go with it; other contexts are untouched. */
export interface HostDisposeContext {
  kind: "disposeContext";
  id: number;
  ctx: string;
}

/** host to kernel: run a piece of model code in one context. */
export interface HostExec {
  kind: "exec";
  id: number;
  ctx: string;
  code: string;
}

/**
 * host to kernel: update `nodeRepl.requestMeta`. Must be sent every turn.
 *
 * KernelInit alone is not enough. The kernel deliberately outlives a turn, since
 * preserving globalThis is the whole point of it, while `turn_id` changes every
 * turn. KernelInit is baked into the env at fork time, so relying on it would
 * freeze turn_id at the first turn. Consumers re-read `requestMeta` on every
 * call, which is why it has to stay updatable.
 */
export interface HostSetRequestMeta {
  kind: "setRequestMeta";
  ctx: string;
  requestMeta: Record<string, unknown>;
}

export type HostToKernel =
  | HostResponse
  | HostEvent
  | HostExec
  | HostSetRequestMeta
  | HostCreateContext
  | HostDisposeContext;

/**
 * The requestMeta key carrying turn metadata. The Computer Use client and the
 * browser client read the same one (see CodexTurnMetadata).
 */
export const CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";

/**
 * The value at `nodeRepl.requestMeta["x-codex-turn-metadata"]`. It is an object,
 * not a JSON string.
 *
 * The effective session id is resolved as: when `thread_source` is "subagent"
 * and `thread_id` is a string, that thread_id wins; otherwise `session_id` is
 * used when it is a string, and nothing otherwise.
 *
 * The two consumers tolerate absence differently, so do not assume they agree:
 * - The Computer Use client runs without it, falling back to `undefined` and
 *   sending `codexTurnMetadata: null`, which the server accepts.
 * - The browser client throws from `getSessionParams()` when session_id or
 *   turn_id is missing.
 */
export interface CodexTurnMetadata {
  session_id?: string;
  turn_id?: string;
  /** Subagent thread id. When `thread_source === "subagent"` it replaces session_id. */
  thread_id?: string;
  /** "subagent" is the only value given special treatment. */
  thread_source?: string;
  /** Operon's own host session id. Used only to clean up the menu bar and PiP;
   *  it takes no part in wire routing. */
  operon_session_id?: string;
}

/**
 * Resolve the effective session_id. A subagent uses its thread_id, which gives
 * it a browser session of its own, with its own tab ownership and leases.
 */
export function resolveCodexSessionId(meta: CodexTurnMetadata | undefined): string | undefined {
  if (meta?.thread_source === "subagent" && typeof meta.thread_id === "string") return meta.thread_id;
  return typeof meta?.session_id === "string" ? meta.session_id : undefined;
}

/** Initial configuration the host passes through env when bootstrapping the kernel. */
export interface KernelInit {
  env: Record<string, string>;
  /**
   * The value is `unknown` rather than `string`: turn metadata is an object and
   * consumers do not JSON.parse it. (KernelInit as a whole goes through env via
   * JSON.stringify/parse, so objects round-trip fine.)
   */
  requestMeta: Record<string, unknown>;
  /** Override for `nodeRepl.tmpDir`; defaults to os.tmpdir(). */
  tmpDir?: string;
}
