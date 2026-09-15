/**
 * The conversation behind a call to a first-party MCP route.
 *
 * Most clients get a server entry per conversation, so the chat id rides the
 * URL. OpenCode cannot: it shares one MCP client per server name across every
 * session in a directory. Its URL carries no chat id; instead a plugin adds the
 * calling OpenCode session to the tool arguments (agent-runtime
 * caller-identity.ts), and this resolves that session to the chat that owns it.
 *
 * The argument is removed here, before the MCP SDK parses the body, so no tool
 * ever sees it. An unknown session is an error, never a fall back to the URL:
 * guessing is exactly how results used to land in another tab.
 */
import type { HttpBindings } from '@hono/node-server'
import type { Context } from 'hono'
import { OPENCODE_CALLER_ARG, resolveOpencodeCaller } from '@operon/agent-runtime'
import { readJsonBody } from './mcp-http.js'

export const UNKNOWN_CALLER_MESSAGE =
  'Operon could not tell which conversation made this call. Send the message again; if it keeps failing, restart the app.'

export type McpCallerResolution =
  | { ok: true; chatId: number | null; body: unknown }
  | { ok: false; response: Response }

type JsonRpcMessage = { id?: unknown; method?: unknown; params?: { arguments?: unknown } }

function parseChatId(raw: string | undefined): number | null {
  const value = Number(raw ?? '')
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** Remove the caller argument from every tools/call in the body; return its value and the call id. */
export function takeCallerArg(body: unknown): { caller?: string; requestId?: unknown } {
  const messages = Array.isArray(body) ? body : [body]
  let found: { caller?: string; requestId?: unknown } = {}
  for (const message of messages as JsonRpcMessage[]) {
    if (!message || typeof message !== 'object' || message.method !== 'tools/call') continue
    const args = message.params?.arguments
    if (!args || typeof args !== 'object' || !(OPENCODE_CALLER_ARG in args)) continue
    const record = args as Record<string, unknown>
    const value = record[OPENCODE_CALLER_ARG]
    delete record[OPENCODE_CALLER_ARG]
    if (found.caller === undefined) found = { caller: typeof value === 'string' ? value : '', requestId: message.id }
  }
  return found
}

/**
 * Resolve the chat for this request. `urlParam` names the query parameter the
 * route has always read the chat id from; it still wins for every client that
 * does not tag its calls.
 */
export async function resolveMcpCallerChat(c: Context, urlParam: string): Promise<McpCallerResolution> {
  const urlChatId = parseChatId(c.req.query(urlParam))
  const { incoming } = c.env as HttpBindings
  if (incoming.method !== 'POST') return { ok: true, chatId: urlChatId, body: undefined }

  const body = await readJsonBody(incoming)
  const { caller, requestId } = takeCallerArg(body)
  if (caller === undefined) return { ok: true, chatId: urlChatId, body }

  const chatId = caller ? parseChatId(resolveOpencodeCaller(caller)) : null
  if (chatId != null) return { ok: true, chatId, body }
  return {
    ok: false,
    response: c.json({
      jsonrpc: '2.0',
      id: requestId ?? null,
      result: { content: [{ type: 'text', text: UNKNOWN_CALLER_MESSAGE }], isError: true },
    }),
  }
}
