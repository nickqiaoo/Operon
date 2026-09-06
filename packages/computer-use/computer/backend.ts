/**
 * The seam between Operon's Computer Use policy layer and whatever engine
 * actually drives the desktop.
 *
 * Everything above this line is product logic and stays engine-agnostic:
 * argument validation, app policy, approval elicitation, appPath substitution,
 * screenshot materialisation, tool-surface reporting. Everything below is
 * engine-specific: request encoding, framing, transport.
 *
 * Two implementations:
 *   - `MacComputerUseClient` (computer/client.ts) speaks CodexComputerUseIPC-2
 *     to the Swift `operon-computer-use` engine. macOS only.
 *   - `CuaDriverBackend` (computer/cua/backend.ts) speaks the line-delimited
 *     JSON daemon protocol to `cua-driver serve`. macOS today, the other two
 *     platforms later.
 *
 * The method set is deliberately the one `index.ts` already calls, in the shapes
 * it already calls them. Phase 0 of the migration introduces this interface
 * without changing a single byte of behaviour: `MacComputerUseClient` satisfies
 * it structurally and remains the default.
 *
 * See docs/cua-driver-migration/design.md.
 */
import type {
  AppIdentifier,
  DirectionName,
  MacAppPolicyResult,
  MacWindowAppState,
  MouseButtonName,
  RequestOptions,
  SelectTextSelectionType,
  SkyDiscoveredApp,
} from "./client.ts";

export type {
  AppIdentifier,
  DirectionName,
  MacAppPolicyResult,
  MacWindowAppState,
  MouseButtonName,
  RequestOptions,
  SelectTextSelectionType,
  SkyDiscoveredApp,
};

export interface ComputerUseBackend {
  listApps(options?: RequestOptions): Promise<SkyDiscoveredApp[]>;
  getAppPolicy(app: AppIdentifier, options?: RequestOptions): Promise<MacAppPolicyResult>;
  getAppState(
    args: { app: AppIdentifier; disableDiff?: boolean },
    options?: RequestOptions,
  ): Promise<MacWindowAppState>;
  click(
    args: {
      app: AppIdentifier;
      clickCount?: number;
      elementIndex?: number;
      mouseButton?: MouseButtonName | number;
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
  performSecondaryAction(
    args: { app: AppIdentifier; action: string; elementIndex: number },
    options?: RequestOptions,
  ): Promise<void>;
  selectText(
    args: {
      app: AppIdentifier;
      elementIndex: number;
      text: string;
      prefix?: string;
      suffix?: string;
      selection?: SelectTextSelectionType;
    },
    options?: RequestOptions,
  ): Promise<void>;
}

/**
 * Environment variable naming the cua-driver daemon socket. Presence selects the
 * cua-driver backend; absence keeps the Swift engine. `CuaDriverService` sets it
 * on the kernel it spawns, so the choice is made by whichever service the host
 * decided to start, not by the model or by kernel code.
 */
export const CUA_DRIVER_SOCKET_ENV = "OPERON_CUA_DRIVER_SOCKET";

interface NodeReplLike {
  nativePipe?: { createConnection?: (path: string) => Promise<unknown> };
  env?: Record<string, string | undefined>;
}

/**
 * Pick the engine for this kernel.
 *
 * The choice is made by whichever service the host started: `CuaDriverService`
 * puts its socket path in the kernel's env, `ComputerUseService` does not. Model
 * code cannot reach `nodeRepl.env` (it lives on the privileged object outside
 * the vm sandbox), so this is not model-settable.
 *
 * Reads `nodeRepl.env` rather than `process.env` for the same reason
 * `resolveSocketPath` does: there is no `process` inside the sandbox.
 */
export async function selectBackend(): Promise<ComputerUseBackend> {
  const repl = (globalThis as { nodeRepl?: NodeReplLike }).nodeRepl;
  const socketPath = repl?.env?.[CUA_DRIVER_SOCKET_ENV];
  if (typeof socketPath === "string" && socketPath !== "") {
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
  const { MacComputerUseClient } = await import("./client.ts");
  return new MacComputerUseClient();
}

type CuaDriverBackendConnect = ConstructorParameters<
  typeof import("./cua/backend.ts").CuaDriverBackend
>[0]["connect"];
