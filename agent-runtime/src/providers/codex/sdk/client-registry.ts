/**
 * Shared app-server connections, one per host.
 *
 * The codex app-server is thread-multiplexed: every request and notification
 * carries a `threadId`, and the per-thread settings a conversation needs — cwd,
 * approval policy, sandbox, model, developer instructions and the whole MCP
 * config — travel with `thread/start` and `turn/start` rather than with the
 * process. So one server can carry every conversation on a host, which is what
 * the Codex desktop app does (its `AppServerConnectionRegistry` is keyed by host
 * id: one for `local`, one per remote SSH host).
 *
 * Only three inputs are genuinely process-level: the codex binary, the
 * environment, and the spawn cwd. The binary and environment form the key here;
 * the spawn cwd is left to whichever session opens the connection, because
 * threads always pass their own.
 */

import { AppServerClient, REQUEST_NOT_HANDLED } from './app-server-client.js';
import type { CodexAppServerSettings } from './types/index.js';

/** A borrowed connection. Call `release` exactly once when the session ends. */
export interface AppServerLease {
  client: AppServerClient;
  release: () => void;
}

interface Entry {
  client: AppServerClient;
  refCount: number;
}

const connections = new Map<string, Entry>();

/**
 * The Codex desktop app keys connections by host id. We only ever talk to the
 * local machine, so the host part is constant; the binary and environment are
 * folded in so a session configured differently gets its own server instead of
 * silently inheriting another one's.
 */
function connectionKey(settings: CodexAppServerSettings, hostId: string): string {
  return JSON.stringify([hostId, settings.codexPath ?? 'codex', settings.env ?? {}]);
}

export function acquireAppServerClient(
  settings: CodexAppServerSettings,
  hostId = 'local',
): AppServerLease {
  const key = connectionKey(settings, hostId);
  let entry = connections.get(key);

  if (!entry) {
    const client = new AppServerClient(settings);
    // Registered once for the connection rather than once per session: it is
    // thread-agnostic, and as a fallback it only runs after every live turn has
    // declined the request.
    //
    // Codex gates MCP tool calls behind an elicitation request
    // (codex_approval_kind: "mcp_tool_call"); with no handler it gets -32601 and
    // the tool call fails. Injected first-party servers (memory /
    // external_agent / workspace_chat / taskboard / im_chat / team_inbox) are
    // auto-approved, and so are user-configured ones for now, because there is
    // no approval UI for MCP tools yet.
    client.onRequest(
      'mcpServer/elicitation/request',
      () => ({ action: 'accept', content: {}, _meta: null }),
      { fallback: true },
    );
    entry = { client, refCount: 0 };
    connections.set(key, entry);
  }

  entry.refCount += 1;
  const held = entry;
  let released = false;

  return {
    client: held.client,
    release: () => {
      if (released) return;
      released = true;
      held.refCount -= 1;
      if (held.refCount > 0) return;
      connections.delete(key);
      held.client.dispose();
    },
  };
}

/** Test seam — drops every connection without waiting for its holders. */
export function disposeAllAppServerClients(): void {
  for (const [key, entry] of connections) {
    connections.delete(key);
    entry.client.dispose();
  }
}

export { REQUEST_NOT_HANDLED };
