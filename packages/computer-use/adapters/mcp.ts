import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createComputerUse, type CreateComputerUseOptions } from "../createComputerUse.ts";
import { NODE_REPL_TOOL_DESCRIPTION } from "./tool.ts";
import type { ElicitationResult } from "../NodeReplHost.ts";
import { CODEX_TURN_METADATA_HEADER, type CodexTurnMetadata } from "../ipc.ts";
import { formatNodeReplError } from "../error-format.ts";

// MCP server adapter: node_repl exposed as an MCP server with a single tool,
// `js`. The server is named node_repl, so the model sees mcp__node_repl__js.
//
// How turn metadata travels:
//   agent loop -> `params._meta["x-codex-turn-metadata"]` on tools/call -> this
//   adapter -> session.run(code, meta) -> the kernel's `nodeRepl.requestMeta` ->
//   read by the Computer Use and browser clients.
//
//   That chain is where the name `requestMeta` comes from: it *is* the `_meta`
//   of the MCP request. Every tools/call can carry a new turn_id, so it has to be
//   passed through on each one; the kernel itself outlives a turn (see ipc.ts).
//   - The browser client throws outright when session_id or turn_id is missing.
//   - The Computer Use client tolerates their absence and sends null, which the
//     server accepts.
//   So a host that sends no _meta is not an error here: each consumer decides.
//
// The synchronous display stream:
//   - Screenshots and text are pushed to the client *during* a tools/call via
//     `notifications/message`, using standard logging notifications so any MCP
//     host can receive them.
//   - The `js` tool takes a second `description` argument, used as the live UI
//     title for that call.
//   - Elicitation is bridged to MCP's `elicitation/create`.

/**
 * Timeout for an elicitation response. People have to read the prompt before
 * answering, so it is generous, but it cannot be unbounded: a hung client would
 * otherwise wedge every cross-origin navigation the agent attempts, forever.
 */
const ELICITATION_TIMEOUT_MS = 5 * 60 * 1000;

const JS_TOOL = {
  name: "js",
  description: NODE_REPL_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "JavaScript to run in the persistent Computer Use session (top-level await ok).",
      },
      description: {
        type: "string",
        description: "Short user-facing description of what this code block is doing (a few words).",
      },
    },
    required: ["source"],
  },
} as const;

const elicitResultSchema = z
  .object({ action: z.string(), content: z.unknown().optional(), _meta: z.unknown().optional() })
  .passthrough();

/** Sink for mid-execution pushes to the client. Each tools/call handler binds it
 *  to that request's context. */
type NotifySink = (params: Record<string, unknown>) => void;

export interface NodeReplMcpServer {
  server: Server;
  dispose(): Promise<void>;
}

export interface NodeReplMcpServerOptions extends CreateComputerUseOptions {
  /**
   * Host identity fallback for MCP clients that do not send Codex's private
   * `x-codex-turn-metadata`. The URL-scoped HTTP route uses this to make the
   * standard MCP contract work for Claude, Gemini, Operon and other clients.
   */
  fallbackTurnMetadata?: () => CodexTurnMetadata | undefined;
  /** Merge host-only lifecycle fields without replacing the client's Codex metadata. */
  turnMetadataAugment?: () => Partial<CodexTurnMetadata> | undefined;
}

export async function buildNodeReplMcpServer(
  opts: NodeReplMcpServerOptions = {},
): Promise<NodeReplMcpServer> {
  const server = new Server(
    { name: "node_repl", version: "0.1.0" },
    { capabilities: { tools: {}, logging: {} } },
  );

  // Live push channel for the current tools/call, set by the handler for the
  // duration of the run. Assumes execution is serial.
  let sink: NotifySink | undefined;
  const streamMessage = (data: Record<string, unknown>) => {
    sink?.({ level: "info", logger: "node_repl", data });
  };

  /**
   * Confirmation for a high-risk action, raised as an MCP `elicitation/create`
   * so the host's UI can ask a person.
   *
   * The client's capabilities must be checked first. `elicitation/create` is a
   * server-to-client *request*, and a client that does not support it will never
   * answer, while `server.request` has no default timeout. That hangs forever.
   * This is not hypothetical: calling `tab.goto()` from an MCP client that had
   * not declared elicitation wedged the entire call, never even reaching the
   * client's own 10s navigation timeout, because it had not got as far as
   * waiting for events. A `catch` does not help, since a hang neither resolves
   * nor rejects.
   *
   * Browser Use routes every cross-origin consent through here, so this path
   * cannot be allowed to hang.
   */
  const requestElicitation = async (req: { message: string; meta?: unknown }): Promise<ElicitationResult> => {
    // The client never declared elicitation, so nothing would answer. Do not send.
    if (server.getClientCapabilities()?.elicitation == null) return { action: "cancel" };
    try {
      const res = await server.request(
        {
          method: "elicitation/create",
          params: { message: req.message, requestedSchema: { type: "object", properties: {} } },
        },
        elicitResultSchema,
        // Backstop: a client that declared the capability but does not answer,
        // because of a bug or a stuck UI, must still not wedge the browser.
        // Allow plenty of time to decide, but a finite amount.
        { timeout: ELICITATION_TIMEOUT_MS },
      );
      const action = res.action === "accept" || res.action === "decline" || res.action === "cancel" ? res.action : "cancel";
      return { action, content: res.content, _meta: res._meta };
    } catch {
      return { action: "cancel" };
    }
  };

  const cu = await createComputerUse({
    ...opts,
    integration: {
      requestElicitation,
      // Live pushes during execution: the screenshot and text stream.
      onOutput: (text) => streamMessage({ type: "text", text }),
      onImage: (img) => {
        if (img.dataBase64) streamMessage({ type: "image", mimeType: img.mimeType ?? "image/png", data: img.dataBase64 });
        else if (img.url) streamMessage({ type: "image", url: img.url });
      },
      ...opts.integration,
    },
  });
  const session = cu.createSession();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [JS_TOOL] }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    if (req.params.name !== "js") {
      return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    }
    const args = (req.params.arguments ?? {}) as { source?: string; code?: string; description?: string };
    const source = args.source ?? args.code ?? "";

    // Bind the live push channel for this request.
    const send = extra.sendNotification as undefined | ((n: { method: string; params: Record<string, unknown> }) => Promise<void>);
    sink = send ? (params) => void send({ method: "notifications/message", params }) : undefined;

    // Turn metadata for this tools/call. It rides the request's _meta and can
    // change on every call.
    const baseTurnMetadata =
      readTurnMetadata(req.params._meta) ?? opts.fallbackTurnMetadata?.();
    const turnMetadataAugment = opts.turnMetadataAugment?.();
    const turnMetadata =
      baseTurnMetadata || turnMetadataAugment
        ? { ...(baseTurnMetadata ?? {}), ...(turnMetadataAugment ?? {}) }
        : undefined;

    try {
      if (args.description) streamMessage({ type: "title", text: args.description }); // live title
      const { result, output, images, responseMeta } = await session.run(source, turnMetadata);
      const text = output + (result !== undefined ? (output ? "\n" : "") + safeJson(result) : "");
      const content: CallToolResult["content"] = [];
      if (text || images.length === 0) content.push({ type: "text", text });
      for (const image of images) {
        if (image.dataBase64) {
          content.push({
            type: "image",
            data: image.dataBase64,
            mimeType: image.mimeType ?? "image/png",
          });
        } else if (image.url) {
          content.push({
            type: "resource_link",
            name: "Emitted image",
            uri: image.url,
            ...(image.mimeType ? { mimeType: image.mimeType } : {}),
          });
        }
      }
      return {
        content,
        ...(Object.keys(responseMeta).length === 0 ? {} : { _meta: responseMeta }),
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: formatNodeReplError(e) }],
        isError: true,
      };
    } finally {
      sink = undefined;
    }
  });

  return { server, dispose: () => cu.dispose() };
}

/**
 * Pull turn metadata out of an MCP request's `_meta`.
 *
 * Shape validation only, with no defaults filled in: a host that sent nothing
 * gets undefined, and each consumer applies its own tolerance (the Computer Use
 * client does not care; the browser client throws a clear error). Quietly
 * inventing a session_id here would be worse than either.
 */
function readTurnMetadata(meta: unknown): CodexTurnMetadata | undefined {
  if (typeof meta !== "object" || meta == null) return undefined;
  const raw = (meta as Record<string, unknown>)[CODEX_TURN_METADATA_HEADER];
  if (typeof raw !== "object" || raw == null) return undefined;
  const m = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    session_id: str(m.session_id),
    turn_id: str(m.turn_id),
    thread_id: str(m.thread_id),
    thread_source: str(m.thread_source),
  };
}

function safeJson(x: unknown): string {
  try {
    return typeof x === "string" ? x : JSON.stringify(x);
  } catch {
    return String(x);
  }
}
