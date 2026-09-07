/**
 * The seam between Operon's Computer Use policy layer and the engine that
 * actually drives the desktop.
 *
 * Everything above this line is product logic and stays engine-agnostic:
 * argument validation, app policy, approval elicitation, appPath substitution,
 * screenshot materialisation, tool-surface reporting. Everything below is
 * engine-specific: request encoding, framing, transport.
 *
 * One implementation: `CuaDriverBackend` (computer/cua/backend.ts), which
 * speaks the line-delimited JSON daemon protocol to `cua-driver serve`.
 *
 * The in-tree Swift engine used to be the other one, selected by the absence of
 * the socket env var below. Its TypeScript half — the client, the service that
 * spawned it, and its wire protocol — has been removed; the Swift package itself
 * is still in `native/computer-use`, so switching back means restoring that half
 * from git history rather than rewriting the engine.
 *
 * See docs/cua-driver-migration/design.md.
 */
import type { CodexMetadata } from "./wire.ts";

// ---------------------------- Vocabulary ----------------------------
//
// The shapes `index.ts` speaks in. They were defined alongside the Swift client
// and outlived it: the field names are the ones the model has been trained on
// in this product, so `CuaDriverBackend` translates cua-driver's vocabulary into
// these rather than the other way round.

export type AppIdentifier = string;
export type MouseButtonName = "left" | "right" | "middle" | "l" | "r" | "m";
export type DirectionName = "up" | "down" | "left" | "right" | "u" | "d" | "l" | "r";
/**
 * The AX actions cua-driver's `click` accepts. A closed set, deliberately: the
 * daemon's tree does not report which actions an element exposes, so a
 * free-form name would be something the caller could only guess at.
 */
export type ClickAction = "press" | "show_menu" | "pick" | "confirm" | "cancel" | "open";

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

export interface RequestOptions {
  codexMetadata?: CodexMetadata;
  timeoutSeconds?: number;
}

export interface ComputerUseBackend {
  listApps(options?: RequestOptions): Promise<SkyDiscoveredApp[]>;
  getAppPolicy(app: AppIdentifier, options?: RequestOptions): Promise<MacAppPolicyResult>;
  getAppState(
    args: {
      app: AppIdentifier;
      disableDiff?: boolean;
      /** Case-insensitive filter: matching actionable rows plus their ancestors.
       *  A Chrome window reports 1500+ nodes; this is how the model asks for the
       *  few it cares about instead of paying for all of them. */
      query?: string;
      /** Cap on nodes walked. */
      maxElements?: number;
      /** Cap on walk depth (daemon default 25). */
      maxDepth?: number;
    },
    options?: RequestOptions,
  ): Promise<MacWindowAppState>;
  click(
    args: {
      app: AppIdentifier;
      clickCount?: number;
      elementIndex?: number;
      mouseButton?: MouseButtonName | number;
      /** An AX action instead of an ordinary press. Requires `elementIndex`. */
      action?: ClickAction;
      x?: number;
      y?: number;
    },
    options?: RequestOptions,
  ): Promise<void>;
  pressKey(args: { app: AppIdentifier; key: string }, options?: RequestOptions): Promise<void>;
  typeText(args: { app: AppIdentifier; text: string }, options?: RequestOptions): Promise<void>;
  scroll(
    args: {
      app: AppIdentifier;
      direction: DirectionName;
      elementIndex?: number;
      x?: number;
      y?: number;
      pages?: number;
    },
    options?: RequestOptions,
  ): Promise<void>;
  setValue(
    args: { app: AppIdentifier; elementIndex: number; value: string },
    options?: RequestOptions,
  ): Promise<void>;
  drag(
    args: { app: AppIdentifier; fromX: number; fromY: number; toX: number; toY: number },
    options?: RequestOptions,
  ): Promise<void>;
  /** Raise the app's window without clicking in it. */
  bringToFront(args: { app: AppIdentifier }, options?: RequestOptions): Promise<void>;

  // ---------------------------------------------------------------------
  // Capabilities beyond the original eight actions.
  //
  // The method set above is the Swift engine's action enum, one for one. It was
  // the right shape while two engines had to satisfy the same interface, but it
  // capped Computer Use at whatever the Swift engine could do — cua-driver
  // exposes 56 tools and this interface reached eleven of them. Everything below
  // is a capability the daemon always had and the seam used to hide.
  // ---------------------------------------------------------------------

  /** A key combination (["cmd", "c"]). `pressKey` sends one key; this sends a chord. */
  hotkey(
    args: { app: AppIdentifier; keys: readonly string[]; elementIndex?: number; x?: number; y?: number },
    options?: RequestOptions,
  ): Promise<void>;

  /**
   * Walk an application menu by path and invoke the final item.
   *
   * Menu bars live outside any window, so their elements cannot be addressed by
   * the window-scoped element index that every action above uses. This is the
   * only way to reach them.
   */
  invokeMenu(
    args: { app: AppIdentifier; path: readonly string[] },
    options?: RequestOptions,
  ): Promise<void>;

  doubleClick(
    args: { app: AppIdentifier; elementIndex?: number; x?: number; y?: number },
    options?: RequestOptions,
  ): Promise<void>;

  rightClick(
    args: { app: AppIdentifier; elementIndex?: number; x?: number; y?: number; modifiers?: readonly string[] },
    options?: RequestOptions,
  ): Promise<void>;

  /**
   * Resize/move a window, verified by an independent read-back.
   *
   * More than a convenience: a list that virtualises its rows only materialises
   * what fits, so an element below the fold has no frame and cannot be acted on
   * at all. Growing the window is often a cleaner fix than scrolling, because it
   * leaves the scroll position alone.
   */
  setWindowFrame(
    args: { app: AppIdentifier; x: number; y: number; width: number; height: number },
    options?: RequestOptions,
  ): Promise<WindowFrame>;

  /** A cropped, magnified capture of one window region. */
  zoom(
    args: { app: AppIdentifier; x1: number; y1: number; x2: number; y2: number },
    options?: RequestOptions,
  ): Promise<{ screenshot: { url?: string | null; mimeType?: string | null } | null }>;

  /** Force-terminate the app. The cooperative path (⌘Q via `hotkey`) comes first. */
  killApp(args: { app: AppIdentifier }, options?: RequestOptions): Promise<void>;

  /** Check bounded predicates against the app's window, with a bounded wait. */
  verifyState(
    args: {
      app: AppIdentifier;
      expect: readonly unknown[];
      timeoutMs?: number;
      stableSamples?: number;
      includeScreenshot?: boolean;
    },
    options?: RequestOptions,
  ): Promise<VerifyStateResult>;

  // ---- Not scoped to an app ----

  /** Logical display size plus the backing scale factor (2.0 on Retina). */
  getScreenSize(options?: RequestOptions): Promise<ScreenSize>;

  /** Full-display capture at true pixel size. Vision only: no accessibility walk. */
  getDesktopState(
    options?: RequestOptions,
  ): Promise<{ screenshot: { url?: string | null; mimeType?: string | null } | null; width?: number; height?: number }>;

  clipboardRead(args?: { includeText?: boolean }, options?: RequestOptions): Promise<ClipboardContents>;

  clipboardWrite(
    args: { text?: string; imagePath?: string; filePath?: string },
    options?: RequestOptions,
  ): Promise<{ types: string[] }>;
}

export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenSize {
  width: number;
  height: number;
  scaleFactor: number;
}

export interface ClipboardContents {
  types: string[];
  text?: string;
}

export interface VerifyStateResult {
  /** `satisfied` / `unsatisfied` / `unknown` — unknown never implies success. */
  status: string;
  results?: unknown[];
  screenshot?: { url?: string | null; mimeType?: string | null } | null;
}

/**
 * Environment variable naming the cua-driver daemon socket. `CuaDriverService`
 * sets it on the kernel it spawns, so the path is decided by the host, not by
 * the model or by kernel code. Its absence means Computer Use is off (or the
 * daemon failed to start), which surfaces as an error on the first `computer.*`
 * call rather than at fork time.
 */
export const CUA_DRIVER_SOCKET_ENV = "OPERON_CUA_DRIVER_SOCKET";

interface NodeReplLike {
  nativePipe?: { createConnection?: (path: string) => Promise<unknown> };
  env?: Record<string, string | undefined>;
}

/**
 * Build the backend for this kernel.
 *
 * The socket path comes from `nodeRepl.env`, which the host fixed at fork time.
 * Model code cannot reach it (it lives on the privileged object outside the vm
 * sandbox), so the engine is not model-settable.
 *
 * Reads `nodeRepl.env` rather than `process.env` because there is no `process`
 * inside the sandbox.
 */
export async function selectBackend(): Promise<ComputerUseBackend> {
  const repl = (globalThis as { nodeRepl?: NodeReplLike }).nodeRepl;
  const socketPath = repl?.env?.[CUA_DRIVER_SOCKET_ENV];
  if (typeof socketPath !== "string" || socketPath === "") {
    throw new Error(
      "Computer Use is not running: no cua-driver socket in this kernel's environment.",
    );
  }
  const create = repl?.nativePipe?.createConnection;
  if (typeof create !== "function") {
    throw new Error("the cua-driver backend requires nodeRepl.nativePipe support");
  }
  const { CuaDriverBackend } = await import("./cua/backend.ts");
  return new CuaDriverBackend({
    socketPath,
    connect: create as CuaDriverBackendConnect,
    sessionId: repl?.env?.OPERON_SESSION_ID,
  });
}

type CuaDriverBackendConnect = ConstructorParameters<
  typeof import("./cua/backend.ts").CuaDriverBackend
>[0]["connect"];
