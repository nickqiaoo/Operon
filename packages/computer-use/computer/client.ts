/**
 * The low-level Mac client: requestType dispatch and action encoding.
 *
 * Every field shape in this file comes from the recordings in
 * the sky-wire-oracle recordings (see README), not from reading a bundle. Three of them are
 * counter-intuitive enough that they have been got wrong before:
 *
 *   - `elementID` is a String (`"5"`), not an Int.
 *   - `mouseButton` is an Int (left 0, right 1, middle 2), not `"left"`.
 *   - `direction`, however, *is* a whole-word String (`"down"`). The asymmetry
 *     with mouseButton is real. Do not "unify" them.
 */
import {
  API_VERSION,
  NativePipeTransport,
  SOCKET_PATH_ENV,
  SkyComputerUseTransportError,
  type CodexMetadata,
  type NativePipeConnection,
} from "./wire.ts";
import path from "node:path";
import os from "node:os";

// --------------------------- requestType table ---------------------------

export const RequestType = {
  listApps: "ComputerUseIPCListAppsRequest",
  appPolicy: "ComputerUseIPCAppPolicyRequest",
  appStart: "ComputerUseIPCAppStartRequest",
  getSkyshot: "ComputerUseIPCAppGetSkyshotRequest",
  performAction: "ComputerUseIPCAppPerformActionRequest",
} as const;

// ------------------------------ Public types ------------------------------

export type AppIdentifier = string;
export type MouseButtonName = "left" | "right" | "middle" | "l" | "r" | "m";
export type DirectionName = "up" | "down" | "left" | "right" | "u" | "d" | "l" | "r";
export type SelectTextSelectionType = "text" | "cursor_before" | "cursor_after";

export interface SkyDiscoveredApp {
  appPath?: string | null;
  bundleIdentifier?: string;
  displayName?: string;
  isFrontmost?: boolean;
  isRunning?: boolean;
  lastUsedDate?: string | null;
  useCount?: number | null;
}

export interface MacAppPolicyTarget {
  appPath: string;
  bundleIdentifier: string;
  displayName: string;
  risk: "high" | "low";
  warningSubtitle?: string | null;
}

export interface MacAppPolicyResult {
  allowPersistentApproval: boolean;
  decision: "allowed" | "denied" | "forbidden";
  target: MacAppPolicyTarget;
}

export interface MacWindowSkyshot {
  text: string;
  screenshot?: { url?: string | null; mimeType?: string | null } | null;
}

export interface MacWindowAppState {
  app: AppIdentifier | { bundleIdentifier?: string; pid?: number };
  appSpecificInstructions?: string | null;
  skyshot?: MacWindowSkyshot;
}

// --------------------------- Value normalisation ---------------------------

/**
 * `left|l` to 0, `right|r` to 1, `middle|m` to 2. A number goes on the wire.
 * An already-numeric 0, 1 or 2 is accepted too.
 */
export function normalizeMouseButton(value: MouseButtonName | number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value === "number") {
    if (value === 0 || value === 1 || value === 2) return value;
    throw new TypeError("mouseButton must be left, right, middle, l, r, m, 0, 1, or 2");
  }
  switch (value.trim().toLowerCase()) {
    case "l":
    case "left":
      return 0;
    case "r":
    case "right":
      return 1;
    case "m":
    case "middle":
      return 2;
    default:
      throw new TypeError("mouseButton must be left, right, middle, l, r, m, 0, 1, or 2");
  }
}

/** `u|up` becomes `"up"`: a whole word goes on the wire here, unlike mouseButton. */
export function normalizeDirection(value: DirectionName): "up" | "down" | "left" | "right" {
  switch (value.trim().toLowerCase()) {
    case "u":
    case "up":
      return "up";
    case "d":
    case "down":
      return "down";
    case "l":
    case "left":
      return "left";
    case "r":
    case "right":
      return "right";
    default:
      throw new TypeError("direction must be up, down, left, or right");
  }
}

/** elementIndex must be an integer, and is encoded as a string on the wire. */
export function normalizeElementIndex(value: number): string {
  if (!Number.isInteger(value)) throw new TypeError("elementIndex must be an integer");
  return String(value);
}

/**
 * Coordinates are rounded to integers before going on the wire.
 *
 * Integers are part of the contract, not an accident: the receiving side takes
 * `[Int]` and converts to Double internally before applying its affine
 * transform. We used to pass floats straight through and relied on our Swift
 * side declaring `[Double]` to absorb them. Both ends agree now, and the Swift
 * side still accepts `[Double]` so it stays liberal in what it receives.
 */
function normalizePoint(x: number | undefined, y: number | undefined, label: string): [number, number] {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError(`${label} must include finite x and y coordinates`);
  }
  return [Math.round(Number(x)), Math.round(Number(y))];
}

/** Action target: an elementIndex becomes elementID, otherwise a coordinate. */
function target(args: { elementIndex?: number; x?: number; y?: number }): unknown {
  if (args.elementIndex == null) {
    return { coordinate: { _0: normalizePoint(args.x, args.y, "coordinate") } };
  }
  return { elementID: { _0: normalizeElementIndex(args.elementIndex) } };
}

// ---------------------------- nodeRepl wiring ----------------------------

interface NodeReplLike {
  nativePipe?: { createConnection?: (path: string) => Promise<NativePipeConnection> };
  env?: Record<string, string | undefined>;
  requestMeta?: Record<string, unknown>;
}

function nodeRepl(): NodeReplLike | undefined {
  return (globalThis as { nodeRepl?: NodeReplLike }).nodeRepl;
}

/**
 * Socket path: `nodeRepl.env` wins, otherwise the App Group default path.
 * Note this reads `nodeRepl.env`, not `process.env`: there is no `process`
 * inside the kernel's vm sandbox.
 */
export function resolveSocketPath(): string {
  const fromEnv = nodeRepl()?.env?.[SOCKET_PATH_ENV];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return path.join(
    os.homedir(),
    "Library",
    "Group Containers",
    "2DC432GLL2.com.openai.sky.CUAService",
    "IPC",
    "computeruse.sock",
  );
}

export interface RequestOptions {
  codexMetadata?: CodexMetadata;
  timeoutSeconds?: number;
}

// ─────────────────────────── client ───────────────────────────

const DEFAULT_TIMEOUT_SECONDS = 120;
const CONNECT_RETRY_WINDOW_MS = 5_000;
const CONNECT_RETRY_DELAY_MS = 250;

/**
 * The low-level client: one method per requestType, responsible for action
 * encoding. Policy and approval live a layer above, in the window API in
 * `index.ts`.
 */
export class MacComputerUseClient {
  private transport: NativePipeTransport | undefined;
  private connecting: Promise<NativePipeTransport> | undefined;
  private readonly timeoutSeconds: number;
  private readonly codexMetadata: CodexMetadata;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(options: RequestOptions = {}) {
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.codexMetadata = options.codexMetadata;
  }

  /** Connects lazily and reuses the connection, reconnecting on the next call if
   *  it has dropped. */
  private async getTransport(): Promise<NativePipeTransport> {
    if (this.transport && !this.transport.isClosed) return this.transport;
    if (this.connecting) return await this.connecting;

    this.connecting = (async () => {
      const create = nodeRepl()?.nativePipe?.createConnection;
      if (typeof create !== "function") {
        throw new SkyComputerUseTransportError("Sky Computer Use requires nodeRepl.nativePipe support");
      }
      const socketPath = resolveSocketPath();
      const started = Date.now();
      let lastError: unknown;
      for (;;) {
        try {
          const socket = await create(socketPath);
          const transport = new NativePipeTransport(socket, API_VERSION);
          await transport.ping();
          this.transport = transport;
          return transport;
        } catch (cause) {
          lastError = cause;
          if (Date.now() - started >= CONNECT_RETRY_WINDOW_MS) break;
          await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
        }
      }
      throw new SkyComputerUseTransportError(
        `Sky Computer Use could not connect at ${socketPath} after ${CONNECT_RETRY_WINDOW_MS}ms`,
        { cause: lastError },
      );
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async request<T>(requestType: string, request: unknown, options: RequestOptions = {}): Promise<T> {
    const run = this.requestQueue.then(async () => {
      const transport = await this.getTransport();
      const fallbackMetadata = nodeRepl()?.requestMeta?.["x-codex-turn-metadata"] as CodexMetadata;
      return await transport.request<T>({
        requestType,
        request,
        codexMetadata:
          options.codexMetadata !== undefined
            ? options.codexMetadata
            : this.codexMetadata !== undefined
              ? this.codexMetadata
              : fallbackMetadata,
        timeoutSeconds: options.timeoutSeconds ?? this.timeoutSeconds,
      });
    });
    this.requestQueue = run.then(() => {}, () => {});
    return await run;
  }

  listApps(options?: RequestOptions): Promise<SkyDiscoveredApp[]> {
    return this.request<SkyDiscoveredApp[]>(RequestType.listApps, {}, options);
  }

  getAppPolicy(app: AppIdentifier, options?: RequestOptions): Promise<MacAppPolicyResult> {
    return this.request<MacAppPolicyResult>(RequestType.appPolicy, { app }, options);
  }

  startApp(app: AppIdentifier, options?: RequestOptions): Promise<MacWindowAppState> {
    return this.request<MacWindowAppState>(RequestType.appStart, { app }, options);
  }

  getAppState(args: { app: AppIdentifier; disableDiff?: boolean }, options?: RequestOptions): Promise<MacWindowAppState> {
    const request: Record<string, unknown> = { app: args.app };
    if (args.disableDiff !== undefined) request.disableDiff = args.disableDiff;
    return this.request<MacWindowAppState>(RequestType.getSkyshot, request, options);
  }

  private performAction(app: AppIdentifier, action: unknown, options?: RequestOptions): Promise<void> {
    return this.request<void>(RequestType.performAction, { app, action }, options);
  }

  click(
    args: { app: AppIdentifier; clickCount?: number; elementIndex?: number; mouseButton?: MouseButtonName | number; x?: number; y?: number },
    options?: RequestOptions,
  ): Promise<void> {
    return this.performAction(
      args.app,
      {
        click: {
          at: target(args),
          clickCount: args.clickCount ?? 1,
          mouseButton: normalizeMouseButton(args.mouseButton),
        },
      },
      options,
    );
  }

  drag(args: { app: AppIdentifier; fromX: number; fromY: number; toX: number; toY: number }, options?: RequestOptions): Promise<void> {
    return this.performAction(
      args.app,
      {
        drag: {
          from: normalizePoint(args.fromX, args.fromY, "drag.from"),
          to: normalizePoint(args.toX, args.toY, "drag.to"),
        },
      },
      options,
    );
  }

  scroll(
    args: { app: AppIdentifier; direction: DirectionName; elementIndex?: number; x?: number; y?: number; pages?: number },
    options?: RequestOptions,
  ): Promise<void> {
    const pages = args.pages ?? 1;
    if (!Number.isFinite(pages) || pages <= 0) throw new TypeError("pages must be a positive number");
    return this.performAction(
      args.app,
      { scroll: { at: target(args), direction: normalizeDirection(args.direction), pages } },
      options,
    );
  }

  setValue(args: { app: AppIdentifier; elementIndex: number; value: string }, options?: RequestOptions): Promise<void> {
    return this.performAction(
      args.app,
      { setValue: { elementID: normalizeElementIndex(args.elementIndex), value: args.value } },
      options,
    );
  }

  performSecondaryAction(args: { app: AppIdentifier; action: string; elementIndex: number }, options?: RequestOptions): Promise<void> {
    return this.performAction(
      args.app,
      { performSecondaryAction: { action: args.action, elementID: normalizeElementIndex(args.elementIndex) } },
      options,
    );
  }

  selectText(
    args: { app: AppIdentifier; elementIndex: number; text: string; prefix?: string; suffix?: string; selection?: SelectTextSelectionType },
    options?: RequestOptions,
  ): Promise<void> {
    // Default to "text" when absent: the recorded contract puts the default on
    // the wire explicitly rather than omitting the key.
    const selectText: Record<string, unknown> = {
      elementID: normalizeElementIndex(args.elementIndex),
      text: args.text,
      selection: args.selection ?? "text",
    };
    if (args.prefix !== undefined) selectText.prefix = args.prefix;
    if (args.suffix !== undefined) selectText.suffix = args.suffix;
    return this.performAction(args.app, { selectText }, options);
  }

  pressKey(args: { app: AppIdentifier; key: string }, options?: RequestOptions): Promise<void> {
    if (args.key.trim() === "") throw new TypeError("key must be a non-empty string");
    return this.performAction(args.app, { pressKey: { _0: args.key } }, options);
  }

  typeText(args: { app: AppIdentifier; text: string }, options?: RequestOptions): Promise<void> {
    return this.performAction(args.app, { type: { _0: args.text } }, options);
  }
}
