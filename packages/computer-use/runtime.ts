import { computer as packagedClient, type WindowComputerUseClient } from "./computer/index.ts";

const COMPUTER_USE_RUNTIME_KEY = Symbol.for("operon.computer-use.runtime");

/** The global the model calls (`computer.click(...)`). Skill docs must match. */
export const COMPUTER_USE_GLOBAL = "computer";

export interface SetupComputerUseRuntimeOptions {
  globals?: Record<string, unknown>;
}

/**
 * Install the Computer Use client into a node_repl JavaScript realm.
 *
 * This mirrors Codex's plugin wrapper: initialization is idempotent within a
 * persistent session, while every fresh session can safely run the same guard.
 */
export async function setupComputerUseRuntime(
  { globals = globalThis as Record<string, unknown> }: SetupComputerUseRuntimeOptions = {},
): Promise<WindowComputerUseClient> {
  const cached = Reflect.get(globalThis, COMPUTER_USE_RUNTIME_KEY) as
    | WindowComputerUseClient
    | undefined;
  const runtime = cached ?? Object.freeze(packagedClient);

  if (cached == null) {
    Reflect.set(globalThis, COMPUTER_USE_RUNTIME_KEY, runtime);
  }
  // Model-facing name. Codex calls this global `sky`; ours is `computer`, to
  // match the feature name the user sees in Settings.
  Reflect.set(globalThis, COMPUTER_USE_GLOBAL, runtime);
  Reflect.set(globals, COMPUTER_USE_GLOBAL, runtime);
  return runtime;
}
