/**
 * OpenCode Code Mode, seen from the host.
 *
 * With V2's default Code Mode the model no longer calls MCP tools directly: it writes a
 * program for the `execute` tool, and the program calls them. The event stream then shows one
 * `execute` part, while the calls that matter to the UI — an external agent run, a schedule, a
 * call that needs approval — happen inside it. This module turns them back into tool parts of
 * their own, so every card and approval works as it does for a direct call. That is the same
 * contract operon's own Code Mode (`RunCode`) follows: a program's nested calls are ordinary
 * top-level tool parts, tagged with the program's call id (`providerMetadata.opencode.programToolCallId`).
 *
 * What OpenCode gives us per nested call, in the `execute` part's `metadata.toolCalls`, is the
 * tool's path, its input and its status — not its output. The caller-identity plugin fills that
 * gap from `tool.execute.after`, appending each nested result to a file next to itself
 * ({@link opencodeNestedResultsDir}); the stream reads it when a call completes.
 */
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { opencodePluginDir, stripOpencodeCallerArg } from './caller-identity.js'

/** The tool OpenCode runs Code Mode programs in. */
export const OPENCODE_CODE_MODE_TOOL = 'execute'

/** One nested result as the plugin records it. */
export interface NestedResult {
  /** The MCP tool's OpenCode key (`<server>_<tool>`). */
  tool: string
  args: unknown
  output: string
}

/** Where nested results are read from; the stream takes it as a parameter so tests can stand one in. */
export interface NestedResultSource {
  read(programCallId: string): NestedResult[]
  forget(programCallId: string): void
}

/** Next to the plugin file: the plugin derives the same directory from its own URL. */
export function opencodeNestedResultsDir(): string {
  return path.join(opencodePluginDir(), 'nested')
}

function resultsFile(programCallId: string): string {
  return path.join(opencodeNestedResultsDir(), `${encodeURIComponent(programCallId)}.jsonl`)
}

export const fileNestedResults: NestedResultSource = {
  read(programCallId) {
    let text: string
    try {
      text = readFileSync(resultsFile(programCallId), 'utf8')
    } catch {
      return []
    }
    const results: NestedResult[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as Partial<NestedResult>
        if (typeof record.tool === 'string' && typeof record.output === 'string') {
          results.push({ tool: record.tool, args: record.args, output: record.output })
        }
      } catch {
        // A line cut short by a concurrent append; the call it belongs to falls back to no output.
      }
    }
    return results
  },
  forget(programCallId) {
    rmSync(resultsFile(programCallId), { force: true })
  },
}

/**
 * A program's tool path (`github.list_issues`) as the OpenCode key a direct call would carry
 * (`github_list_issues`): server and tool joined by `_`. Renderers that recognize a tool by
 * name then match a nested call exactly as they match a direct one.
 */
export function nestedToolKey(toolPath: string): string {
  const dot = toolPath.indexOf('.')
  return dot < 0 ? toolPath : `${toolPath.slice(0, dot)}_${toolPath.slice(dot + 1)}`
}

/** One entry of the `execute` part's `metadata.toolCalls`. */
export interface NestedCallProgress {
  tool: string
  status: 'running' | 'completed' | 'error'
  input?: Record<string, unknown>
}

export function nestedCallsOf(metadata: unknown): NestedCallProgress[] | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined
  const calls = (metadata as { toolCalls?: unknown }).toolCalls
  if (!Array.isArray(calls)) return undefined
  return calls.map((call): NestedCallProgress => {
    const entry = (call && typeof call === 'object' ? call : {}) as Record<string, unknown>
    const status = entry.status === 'completed' || entry.status === 'error' ? entry.status : 'running'
    const input = entry.input && typeof entry.input === 'object' && !Array.isArray(entry.input)
      ? (entry.input as Record<string, unknown>)
      : undefined
    return { tool: typeof entry.tool === 'string' ? entry.tool : '', status, ...(input ? { input } : {}) }
  })
}

/** A nested call surfaced as its own tool part. */
export interface NestedCallState {
  id: string
  toolName: string
  /** The input as JSON, caller argument stripped — what the tool part shows. */
  input: string
  approvalAsked: boolean
  resultEmitted: boolean
}

/** Everything the stream tracks for one `execute` call. */
export interface CodeModeProgram {
  calls: NestedCallState[]
  /** Indices of result records already matched to a call. */
  consumed: Set<number>
}

export function createCodeModeProgram(): CodeModeProgram {
  return { calls: [], consumed: new Set() }
}

/**
 * The recorded output of `call`. Matched on tool key and input rather than on position: the
 * program's call counter and the plugin's are not guaranteed to agree (a call rejected before
 * it runs takes a slot on one side only). The first unclaimed record of the same tool is the
 * fallback when no input matches exactly.
 */
export function takeNestedResult(
  program: CodeModeProgram,
  programCallId: string,
  call: NestedCallState,
  source: NestedResultSource,
): string | undefined {
  const results = source.read(programCallId)
  const free = (index: number) => !program.consumed.has(index)
  let index = results.findIndex((result, i) =>
    free(i) && result.tool === call.toolName && JSON.stringify(stripOpencodeCallerArg(result.args) ?? {}) === call.input)
  if (index < 0) index = results.findIndex((result, i) => free(i) && result.tool === call.toolName)
  if (index < 0) return undefined
  program.consumed.add(index)
  return results[index]!.output
}
