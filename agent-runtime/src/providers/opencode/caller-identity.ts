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
 *
 * The same plugin records the results of Code Mode's nested calls (see
 * `code-mode.ts`): `tool.execute.after` sees them, the event stream does not.
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
// `assistant` covers the personal assistant's own servers (`assistant`, `assistant_worker`, …).
const CALLER_ROUTED_SERVERS = ['external_agent', 'workflow', 'node_repl', 'schedule', 'assistant']

/** A nested result kept for a card is capped; the program itself still gets all of it. */
const NESTED_RESULT_MAX_CHARS = 64_000

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
 * V2's plugin context exposes the session API and scoped tool hooks directly.
 */
export const OPENCODE_CALLER_PLUGIN_SOURCE = `import { appendFile, mkdir } from "node:fs/promises"

const ARG = ${JSON.stringify(OPENCODE_CALLER_ARG)}
const PREFIXES = ${JSON.stringify(CALLER_ROUTED_SERVERS.flatMap((name) => [`${name}_`, `${name}.`]))}
// Code Mode results, one JSON line per nested call, in a file per program ("execute" call).
const NESTED_DIR = new URL("./nested/", import.meta.url)
const MAX_RESULT = ${String(NESTED_RESULT_MAX_CHARS)}

export default {
  id: "operon.caller-identity",
  async setup(ctx) {
  const roots = new Map()
  const programs = new Set()
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
        const result = await ctx.session.get({ sessionID: current })
        parentID = result.parentID
      } catch {
        return current
      }
      if (!parentID) break
      current = parentID
    }
    for (const id of walked) roots.set(id, current)
    return current
  }
  await ctx.tool.hook("execute.before", async (event) => {
    if (event.tool === "execute") {
      programs.add(event.sessionID + ":" + event.id)
      return
    }
    if (!PREFIXES.some((prefix) => event.tool.startsWith(prefix))) return
    if (!event.input || typeof event.input !== "object") return
    event.input[ARG] = await rootOf(event.sessionID)
  })
  await ctx.tool.hook("execute.after", async (event) => {
    const callID = typeof event.id === "string" ? event.id : ""
    const key = event.sessionID + ":" + callID
    if (event.tool === "execute") {
      programs.delete(key)
      return
    }
    // V2's nested hooks carry the outer execute id, rather than an id per child.
    if (!callID || !programs.has(key)) return
    const record = { tool: event.tool, args: event.input ?? {}, output: resultText(event.result) }
    try {
      await mkdir(NESTED_DIR, { recursive: true })
      await appendFile(new URL(encodeURIComponent(callID) + ".jsonl", NESTED_DIR), JSON.stringify(record) + "\\n")
    } catch {}
  })
  },
}

// An MCP result's text, or its structured content when it has no text.
function resultText(output) {
  if (!output || typeof output !== "object") return ""
  if (typeof output.output === "string") return output.output.slice(0, MAX_RESULT)
  if (typeof output.content === "string") return output.content.slice(0, MAX_RESULT)
  const texts = Array.isArray(output.content)
    ? output.content.filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text)
    : []
  const text = texts.length > 0 ? texts.join("\\n") : output.structuredContent !== undefined ? JSON.stringify(output.structuredContent) : ""
  return text.slice(0, MAX_RESULT)
}
`

/** Where the plugin file lives; Code Mode results go in `nested/` beside it. */
export function opencodePluginDir(): string {
  return path.join(tmpdir(), 'operon-opencode')
}

/** Write the plugin where the OpenCode server can load it; returns its file URL. */
export function writeOpencodeCallerPlugin(): string {
  const dir = opencodePluginDir()
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'index.js')
  writeFileSync(file, OPENCODE_CALLER_PLUGIN_SOURCE, 'utf8')
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'operon-caller-identity', type: 'module', exports: './index.js' }), 'utf8')
  return pathToFileURL(dir).href
}

/** Hide the injected argument from the tool input shown in the transcript. */
export function stripOpencodeCallerArg(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !(OPENCODE_CALLER_ARG in input)) return input
  const { [OPENCODE_CALLER_ARG]: _caller, ...rest } = input as Record<string, unknown>
  return rest
}
