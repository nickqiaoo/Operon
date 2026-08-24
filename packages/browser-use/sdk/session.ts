/**
 * Session parameters for operon's browser SDK.
 *
 * Every wire request merges the same triple, `{session_id, turn_id,
 * session_context}`. The backend uses `session_id` for echo-mode ownership and
 * for tab leases, so getting this wrong makes everything else wrong.
 *
 * The contract comes from the wire-oracle recordings (see README). Do not
 * guess it: the Computer Use side once inferred a contract from a minified bundle
 * and hand-wrote the expectations to match, which was self-consistently wrong
 * with every test green and the product broken.
 */

/** Turn metadata hangs off nodeRepl under the key `x-codex-turn-metadata`. */
const TURN_METADATA_KEY = "x-codex-turn-metadata";

export interface TurnMetadata {
  session_id?: string;
  turn_id?: string;
  /** For a subagent, session_id is not the ownership key; see resolveSessionId. */
  thread_source?: string;
  thread_id?: string;
}

interface NodeReplLike {
  requestMeta?: Record<string, TurnMetadata | undefined>;
}

/** Read the turn metadata off `globalThis.nodeRepl.requestMeta`. */
export function getTurnMetadata(): TurnMetadata | undefined {
  return (globalThis as { nodeRepl?: NodeReplLike }).nodeRepl?.requestMeta?.[TURN_METADATA_KEY];
}

/**
 * Resolve the effective session id: a subagent is identified by its `thread_id`
 * rather than by `session_id`.
 *
 * The backend echoes whatever `session_id` arrives in the params, so this
 * resolution has to be correct on the client. The backend has no way to work it
 * out (see the echo-mode comment in IabBackend).
 */
export function resolveSessionId(meta: TurnMetadata | undefined = getTurnMetadata()): string | undefined {
  if (meta?.thread_source === "subagent" && typeof meta.thread_id === "string") return meta.thread_id;
  return typeof meta?.session_id === "string" ? meta.session_id : undefined;
}

export interface SessionParams {
  session_id: string;
  turn_id: string;
  session_context: "live" | "cached";
}

/**
 * The session params attached to every request:
 * ```js
 * getSessionParams(){
 *   let r = this.getTurnMetadata();
 *   if (r == null && this.lastSessionParams != null)
 *     return { ...this.lastSessionParams, session_context: "cached" };
 *   let n = Yt(r);
 *   if (typeof n != "string") throw new Error("Missing required browser session_id");
 *   let o = r?.turn_id;
 *   if (typeof o != "string") throw new Error("Missing required browser turn_id");
 *   return this.lastSessionParams = { session_id: n, turn_id: o },
 *          { ...this.lastSessionParams, session_context: "live" };
 * }
 * ```
 *
 * Two behaviours are deliberate:
 * - When metadata is absent, fall back to the previous turn's cache and mark it
 *   `session_context: "cached"` rather than throwing. A host may not refresh
 *   requestMeta between turns, and throwing would invalidate every tab handle at
 *   the end of one.
 * - Throw only when it has never succeeded. Unlike the Computer Use client, which
 *   tolerates missing metadata, the browser client does not; see the ipc.ts
 *   comment in `@operon/computer-use`.
 */
export class SessionParamsSource {
  private lastSessionParams: { session_id: string; turn_id: string } | undefined;

  get(): SessionParams {
    const meta = getTurnMetadata();
    if (meta == null && this.lastSessionParams != null) {
      return { ...this.lastSessionParams, session_context: "cached" };
    }
    const sessionId = resolveSessionId(meta);
    if (typeof sessionId !== "string") throw new Error("Missing required browser session_id");
    const turnId = meta?.turn_id;
    if (typeof turnId !== "string") throw new Error("Missing required browser turn_id");
    this.lastSessionParams = { session_id: sessionId, turn_id: turnId };
    return { ...this.lastSessionParams, session_context: "live" };
  }
}
