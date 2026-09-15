/**
 * Which host conversation is calling a shared MCP server from OpenCode.
 *
 * OpenCode registers MCP servers per directory, not per session: every session
 * in a workspace shares one `external_agent` client, and `mcp.add` under the
 * same name only overwrites it. A chat id baked into the URL therefore belongs
 * to whichever conversation registered first, and the next tab's delegations
 * report back to that one.
 *
 * So for OpenCode the identity travels with each call instead. A plugin loaded
 * into the OpenCode server adds the calling session's root id to the arguments
 * of the first-party tools that route by conversation (`tool.execute.before`
 * runs with the real `sessionID` and mutates the args handed to the MCP call).
 * The host looks that id up in the map below and strips the argument before the
 * tool sees it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Tool argument carrying the OpenCode root session id. Removed by the host. */
export const OPENCODE_CALLER_ARG = '__operon_opencode_session'

/**
 * MCP servers whose tools get the argument. OpenCode names an MCP tool
 * `<server>_<tool>`, so the plugin matches on the server prefix. Other servers
 * (including the user's own) never see it.
 */
const CALLER_ROUTED_SERVERS = ['external_agent', 'workflow', 'node_repl']

/** OpenCode root session id -> host conversation id. */
const conversationBySession = new Map<string, string>()

export function bindOpencodeCaller(sessionId: string, conversationId: string): void {
  conversationBySession.set(sessionId, conversationId)
}

/** Only drops the binding when it still points at this conversation. */
export function unbindOpencodeCaller(sessionId: string, conversationId: string): void {
  if (conversationBySession.get(sessionId) === conversationId) conversationBySession.delete(sessionId)
}

export function resolveOpencodeCaller(sessionId: string): string | undefined {
  return conversationBySession.get(sessionId)
}

/**
 * Sub-agents run in child sessions, and it is the child's id that reaches the
 * hook. Walking `parentID` up to the root keeps the host map to one entry per
 * conversation. A failed lookup is not cached, so a transient error does not pin
 * a child to itself.
 *
 * Written as a named function export, the original plugin shape: OpenCode
 * releases before the `export default { id, server }` form (2026-03) reject that
 * form, and newer ones still load a module with no default export this way.
 */
export const OPENCODE_CALLER_PLUGIN_SOURCE = `const ARG = ${JSON.stringify(OPENCODE_CALLER_ARG)}
const PREFIXES = ${JSON.stringify(CALLER_ROUTED_SERVERS.map((name) => `${name}_`))}

export const OperonCallerIdentity = async ({ client }) => {
  const roots = new Map()
  const rootOf = async (sessionID) => {
    const walked = []
    let current = sessionID
    for (let depth = 0; depth < 32; depth++) {
      const known = roots.get(current)
      if (known) {
        current = known
        break
      }
      walked.push(current)
      let parentID
      try {
        const result = await client.session.get({ path: { id: current } })
        parentID = result && result.data ? result.data.parentID : undefined
      } catch {
        return current
      }
      if (!parentID) break
      current = parentID
    }
    for (const id of walked) roots.set(id, current)
    return current
  }
  return {
    "tool.execute.before": async (input, output) => {
      if (!PREFIXES.some((prefix) => input.tool.startsWith(prefix))) return
      if (!output.args || typeof output.args !== "object") return
      // Mutate in place: the same object is what the MCP call sends.
      output.args[ARG] = await rootOf(input.sessionID)
    },
  }
}
`

/** Write the plugin where the OpenCode server can load it; returns its file URL. */
export function writeOpencodeCallerPlugin(): string {
  const dir = path.join(tmpdir(), 'operon-opencode')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'operon-caller-identity.mjs')
  writeFileSync(file, OPENCODE_CALLER_PLUGIN_SOURCE, 'utf8')
  return pathToFileURL(file).href
}

/** Hide the injected argument from the tool input shown in the transcript. */
export function stripOpencodeCallerArg(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !(OPENCODE_CALLER_ARG in input)) return input
  const { [OPENCODE_CALLER_ARG]: _caller, ...rest } = input as Record<string, unknown>
  return rest
}
