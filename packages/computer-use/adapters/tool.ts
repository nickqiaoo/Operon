import { z } from "zod";
import type { NodeReplSession, NodeReplRunResult } from "../NodeReplSession.ts";

// Optional zod tool adapter: wraps a persistent session as the
// `mcp__node_repl__js` tool.
// The core (NodeReplSession, Host, kernel) does not depend on zod; only this
// adapter does. Another framework can be supported by writing its own adapter
// the same way, without touching the core.

export const nodeReplInputSchema = z.object({
  code: z
    .string()
    .describe("JavaScript to run in the persistent Computer Use node_repl session (top-level await ok)"),
});

/**
 * A capability the kernel was configured with. One node_repl backs all three,
 * but which globals exist depends on the Settings toggles that were on when
 * the session was built (see `buildEntry` in server/src/routes/node-repl-mcp.ts).
 */
export type NodeReplSurface = "computer" | "browser" | "chrome";

export const ALL_NODE_REPL_SURFACES: readonly NodeReplSurface[] = [
  "computer",
  "browser",
  "chrome",
];

const BASE_DESCRIPTION =
  "Run JavaScript in a persistent node_repl session. `globalThis` and anything assigned to it " +
  "survive across calls; bindings declared with const/let do not, because each call runs in its " +
  "own function scope. Top-level await is supported.";

const OUTPUT_DESCRIPTION =
  "Use `nodeRepl.write(value)` for text output and `await nodeRepl.emitImage(image)` for images. " +
  "Wrap objects in `JSON.stringify(...)` to read them whole.";

/**
 * Per-surface paragraph, or the line that says the surface is off.
 *
 * Saying "disabled" out loud matters more than saying nothing. node_repl is
 * mounted when *any* of the three toggles is on, so a Browser-only session used
 * to advertise `computer.*` — an API that did not exist in it — and the model
 * would burn a turn discovering that by ReferenceError.
 */
const SURFACE_DESCRIPTIONS: Record<NodeReplSurface, string> = {
  computer:
    "`computer.*` drives local Mac apps (reading and operating their UI). See the " +
    "operon-computer-use skill for the workflow and confirmation policy.",
  browser:
    "`agent.browsers.get(\"iab\")` binds Operon's in-app browser, for localhost and throwaway " +
    "navigation. See the operon-browser-use skill.",
  chrome:
    "`agent.browsers.get(\"extension\")` binds the user's own Chrome, with their real logins and " +
    "history. See the operon-chrome skill.",
};

const SURFACE_DISABLED: Record<NodeReplSurface, string> = {
  computer: "Computer Use is disabled in this session; `computer` is not defined.",
  browser: "The in-app browser is disabled in this session.",
  chrome: "Chrome control is disabled in this session.",
};

/**
 * Assemble the `js` tool description for the surfaces this session actually has.
 *
 * The runtime for every enabled surface is installed before the model's first
 * line of code runs (see `banner` in NodeReplSession), so the description
 * promises globals that are genuinely there — no bootstrap snippet to copy.
 */
export function buildNodeReplToolDescription(
  surfaces: readonly NodeReplSurface[] = ALL_NODE_REPL_SURFACES,
): string {
  const enabled = new Set(surfaces);
  if (enabled.size === 0) {
    // Nothing to drive. Say so once rather than listing three absences: this
    // session is a plain JavaScript sandbox.
    return [
      BASE_DESCRIPTION,
      "No Computer Use or browser surface is enabled in this session, so neither `computer` nor " +
        "`agent` exists. This is a plain JavaScript sandbox.",
      OUTPUT_DESCRIPTION,
    ].join("\n\n");
  }
  const globals: string[] = [];
  if (enabled.has("computer")) globals.push("`computer`");
  if (enabled.has("browser") || enabled.has("chrome")) globals.push("`agent`");
  const preamble =
    `The runtime is already initialized: ${globals.join(" and ")} ` +
    `${globals.length > 1 ? "are" : "is"} available on the first call. ` +
    "Do not import or set up a client yourself.";
  const lines = ALL_NODE_REPL_SURFACES.map((surface) =>
    enabled.has(surface) ? SURFACE_DESCRIPTIONS[surface] : SURFACE_DISABLED[surface],
  );
  return [BASE_DESCRIPTION, preamble, ...lines, OUTPUT_DESCRIPTION].join("\n\n");
}

export const JS_RESET_TOOL_DESCRIPTION =
  "Reset the persistent node_repl session. Every global and variable is discarded and the next " +
  "`js` call starts a fresh runtime for the enabled surfaces. This does NOT close browser tabs " +
  "or native apps, or erase their state. Use it when the session is wedged, not to tidy up.";

/** Description for a session with every surface on; the MCP adapter builds a
 *  per-session one from the toggles instead. */
export const NODE_REPL_TOOL_DESCRIPTION = buildNodeReplToolDescription();

/**
 * Default ceiling on the text of one tool result, in tokens. A full
 * accessibility tree runs to tens of thousands on its own, and nothing else
 * between the kernel and the model's context caps it.
 *
 * Matches the `output_token_limit` Codex sets on its own `js` tool.
 */
export const DEFAULT_OUTPUT_TOKEN_LIMIT = 25_000;

/** Rough tokens-to-characters factor. Deliberately generous: the point is to
 *  stop a runaway result, not to bill for it. */
const CHARS_PER_TOKEN = 4;

/**
 * Trim an oversized result, keeping both ends.
 *
 * The head carries the structure the model is reading (a tree, a listing) and
 * the tail carries the last `write` and the completion value, which is usually
 * the answer. Dropping either end alone loses one of them.
 */
export function clampNodeReplOutput(text: string, tokenLimit: number): string {
  const limit = Math.max(1, tokenLimit) * CHARS_PER_TOKEN;
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  const dropped = text.length - limit;
  return (
    text.slice(0, head) +
    `\n\n[node_repl truncated ${dropped} characters of output. Narrow what you emit — ` +
    `select the subtree or fields you need instead of writing everything.]\n\n` +
    text.slice(text.length - tail)
  );
}

export interface NodeReplTool {
  name: string;
  description: string;
  inputSchema: typeof nodeReplInputSchema;
  execute(args: { code: string }): Promise<NodeReplRunResult>;
}

export function createNodeReplTool(session: NodeReplSession): NodeReplTool {
  return {
    name: "node_repl_js", // surfaces to the model as mcp__node_repl__js
    description: NODE_REPL_TOOL_DESCRIPTION,
    inputSchema: nodeReplInputSchema,
    execute: (args) => session.run(args.code),
  };
}
