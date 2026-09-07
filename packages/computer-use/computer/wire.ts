/**
 * Shared transport vocabulary for the Computer Use backends: the two error
 * classes, the server error-code table, and the shape of a `nativePipe`
 * connection.
 *
 * This file used to also carry the Swift engine's wire protocol —
 * `CodexComputerUseIPC-2` length-prefixed framing, the `operon/authenticate`
 * startup-token frame, and a JSON-RPC transport over it. That engine is no
 * longer wired up (cua-driver speaks line-delimited JSON and authenticates by
 * the 0700 directory its socket lives in), so only the pieces both sides shared
 * are left. The Swift service itself is still in `native/computer-use`.
 */
import { Buffer } from "node:buffer";

// ------------------------------- Errors -------------------------------

/** Structured error codes a server can return. Kept as the vocabulary callers
 *  match on; `CuaDriverBackend` maps the daemon's failures onto them. */
export const ServerErrorCode = {
  senderProcessNotAuthenticated: -10000,
  couldNotGetRequestData: -10001,
  couldNotGetRequestTypeName: -10002,
  couldNotResolveRequestType: -10003,
  unhandledEvent: -10004,
  unknownError: -10005,
  appNotAllowed: -10006,
  runningApplicationNotFound: -10007,
  accessibilityError: -10008,
  permissionsNotGranted: -10009,
  invalidApp: -10010,
  noActiveSession: -10011,
  userStoppedSession: -10012,
  incompatibleClientVersion: -10013,
  permissionsPending: -10014,
  blockedURL: -10015,
  userIntervened: -10016,
  couldNotGetSenderPID: -10017,
  ambiguousApp: -10018,
  couldNotGetBootstrapPort: -10019,
  screenLocked: -10020,
} as const;

/** The server refused explicitly, as a JSON-RPC error. */
export class SkyComputerUseError extends Error {
  code: number;
  request: unknown;
  requestType: string;
  constructor(args: { code: number; message: string; request: unknown; requestType: string }) {
    super(args.message);
    this.name = "SkyComputerUseError";
    this.code = args.code;
    this.request = args.request;
    this.requestType = args.requestType;
  }
}

/** Cannot connect, malformed frame, or invalid protocol. A transport problem
 *  rather than a refusal by the server. */
export class SkyComputerUseTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SkyComputerUseTransportError";
  }
}

// ─────────────────────────── transport ───────────────────────────

/** The connection `nodeRepl.nativePipe.createConnection` hands back; only these
 *  members are used. */
export interface NativePipeConnection {
  write(data: Uint8Array): void;
  end(): void;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
}

export type CodexMetadata = string | Uint8Array | Record<string, unknown> | null | undefined;

/**
 * Normalise turn metadata: null, undefined and plain objects pass through
 * untouched, while byte views such as Uint8Array are parsed as UTF-8 JSON.
 * (undefined is dropped by JSON.stringify, so the key never reaches the wire,
 * and the server accepts its absence.)
 */
export function normalizeCodexMetadata(meta: CodexMetadata): unknown {
  if (meta == null) return meta;
  if (typeof meta === "object" && !ArrayBuffer.isView(meta)) return meta;
  return JSON.parse(Buffer.from(meta as Uint8Array | string).toString("utf8"));
}
