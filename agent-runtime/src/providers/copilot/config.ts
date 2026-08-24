import type { ModelMessage } from 'ai'
import { getRuntimeHost } from '../../host.js'
import type { ProviderDescriptor } from '../../types.js'

/** Explicit process-level override, highest priority. Mainly for development. */
export const COPILOT_CLI_PATH = process.env.COPILOT_CLI_PATH || undefined

/**
 * Locate the `copilot` CLI the user installed.
 *
 * We do NOT ship one. `@github/copilot-sdk` would happily fall back to its
 * bundled `@github/copilot` platform package, but that is a 235M native binary
 * the build excludes, so the fallback would only find a package that isn't
 * there and throw `Could not resolve a @github/copilot platform package` at the
 * user. Resolving here — and failing with a sentence that says what to do —
 * matches how Claude Code has always worked.
 *
 * Callers MUST pass the result to `RuntimeConnection.forStdio({ path })`
 * unconditionally. Handing the SDK `{ path: undefined }` is not the same thing:
 * its `conn.path ?? env.COPILOT_CLI_PATH ?? getBundledCliPath()` chain would
 * short-circuit straight into that bundled lookup.
 */
export function resolveCopilotCliPath(): string {
  const cliPath = COPILOT_CLI_PATH ?? getRuntimeHost().resolveCliPath('copilot')
  if (!cliPath) {
    throw new Error(
      'GitHub Copilot CLI not found. Install it (`brew install copilot-cli` or `npm i -g @github/copilot`), or set the path in Settings.',
    )
  }
  return cliPath
}

/**
 * A file-less `--import` payload that deletes `process.versions.electron` before
 * the bundled runtime's entry module loads. ELECTRON_RUN_AS_NODE makes the
 * Electron binary behave like Node, but it leaves `process.versions.electron`
 * set — and the runtime's CLI parser (commander) treats a set `electron` version
 * as "running inside Electron" and strips only ONE leading argv entry instead of
 * two, so the script path itself is read as a stray positional and the CLI dies
 * with `error: too many arguments. Expected 0 arguments but got 1` before it ever
 * serves a request (start() then fails). Clearing the field makes commander parse
 * argv as plain Node. A `data:` URL avoids shipping/resolving a shim file; it runs
 * before the entry module, and the delete is a harmless no-op under real Node.
 */
const STRIP_ELECTRON_VERSION_NODE_OPTION =
  '--import data:text/javascript,' + encodeURIComponent('try{delete process.versions.electron}catch{}')

/**
 * Environment for the spawned copilot runtime.
 *
 * Scope note: since we stopped bundling the runtime, this only bites when the
 * resolved CLI path ends in `.js` — the SDK branches on that and runs those
 * through `process.execPath`, while a normal PATH install (native binary, or an
 * npm shim whose path has no extension) is spawned directly and never sees any
 * of it. Kept because pointing COPILOT_CLI_PATH at an `index.js` is still a
 * legitimate thing to do, and because every part of it is inert otherwise.
 *
 * The SDK runs a `.js` runtime with `process.execPath`; inside the Electron main process that's
 * the Electron binary, and without ELECTRON_RUN_AS_NODE it boots a FULL Electron
 * app (Chromium/window/GPU) to run the script — whose event loop and stdio
 * pipes differ from Node's, which stalls the runtime's stdio JSON-RPC handshake
 * (start()/listModels never resolve → models + chat hang). Setting
 * ELECTRON_RUN_AS_NODE=1 makes that same binary run as plain Node (clean stdio,
 * no Chromium); the bundled runtime additionally needs `node:sqlite`, which only
 * exists on Node 22.5+ — i.e. Electron 35+ (Electron 40 ships Node 24). On top of
 * that we strip `process.versions.electron` via NODE_OPTIONS so the runtime's CLI
 * arg parser doesn't misread argv (see STRIP_ELECTRON_VERSION_NODE_OPTION). All
 * of this is inert outside Electron (real node ignores ELECTRON_RUN_AS_NODE, and
 * the delete is a no-op).
 */
export function copilotRuntimeEnv(
  extra?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...process.env, ...extra }
  if (!process.versions.electron) return merged
  // Append our flag so any NODE_OPTIONS the caller/host already set is preserved.
  const nodeOptions = [merged.NODE_OPTIONS, STRIP_ELECTRON_VERSION_NODE_OPTION]
    .filter(Boolean)
    .join(' ')
  return { ...merged, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: nodeOptions }
}

/**
 * `auto` lets Copilot route to the best available model. It is account- and
 * plan-independent (always present in `listModels()`), which makes it the only
 * safe universal default — the concrete models a user can pick (gpt-5, sonnet,
 * etc.) vary by their Copilot subscription. Live options come from listModels()
 * only; no static model table (it drifts by plan/version).
 */
export const COPILOT_DEFAULT_MODEL = 'auto'

/**
 * The Copilot CLI's three execution modes, surfaced 1:1 so our picker matches
 * what `copilot` shows. Each maps to the SDK's `agentMode` (see copilotAgentMode)
 * AND to how `onPermissionRequest` behaves (see session.ts):
 *   interactive ("Normal") → agentMode 'interactive'; the handler surfaces an
 *                            approval card per write/shell/MCP action and waits
 *   plan                   → agentMode 'plan'; the agent drafts a plan and
 *                            requests to exit via onExitPlanModeRequest
 *   autopilot              → agentMode 'autopilot'; the handler approves all
 * The SDK also defines a 'shell' agentMode, which the CLI does not surface as a
 * user mode, so we don't either.
 */
export const COPILOT_MODES = [
  { id: 'interactive', name: 'Normal', description: 'Ask before each write, shell, or MCP action' },
  { id: 'plan', name: 'Plan', description: 'Draft a plan first, then execute on your approval' },
  { id: 'autopilot', name: 'Autopilot', description: 'Approve all tool calls (writes, shell, MCP) automatically' },
]

/**
 * Default mode. Kept as autopilot (the prior behavior) so existing chats don't
 * suddenly start prompting; users opt into Normal/Plan from the picker.
 */
export const COPILOT_DEFAULT_MODE = 'autopilot'

export type CopilotAgentMode = 'interactive' | 'plan' | 'autopilot'

/**
 * Map our mode id to the SDK `agentMode` passed on each turn. Legacy ids from
 * older sessions are folded in: 'default' was autopilot behavior; 'readOnly'
 * restricted writes, which now maps to the prompt-per-action interactive mode.
 */
export function copilotAgentMode(modeId?: string): CopilotAgentMode {
  switch (modeId) {
    case 'plan':
      return 'plan'
    case 'interactive':
    case 'readOnly':
      return 'interactive'
    // 'autopilot' / legacy 'default' / undefined
    default:
      return 'autopilot'
  }
}

/** Modes whose `onPermissionRequest` surfaces a per-action approval card. */
export function copilotModeAsksApproval(modeId?: string): boolean {
  return copilotAgentMode(modeId) === 'interactive'
}

/**
 * Reasoning-effort levels offered in the picker. The SDK's `ReasoningEffort` has
 * only these four (no 'max', unlike claude). Which of them a given model actually
 * accepts is plan/model-specific (ModelInfo.supportedReasoningEfforts), so the
 * session only passes an effort the selected model lists — see session.ts.
 */
export const COPILOT_THINKING_LEVELS: ProviderDescriptor['thinkingLevels'] = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'xhigh', name: 'xHigh' },
]

export type CopilotReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

/**
 * Validate a UI thinking-level id into an SDK `reasoningEffort`. Returns
 * undefined for unset/unknown levels (including claude's 'max', which Copilot
 * doesn't support) so the caller omits the field rather than sending a bad value.
 */
export function resolveReasoningEffort(level?: string): CopilotReasoningEffort | undefined {
  switch (level) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return level
    default:
      return undefined
  }
}

/**
 * Tool names the runtime uses for the two interactive callbacks we surface
 * ourselves (ask_user via onUserInputRequest, exit_plan_mode via
 * onExitPlanModeRequest). The handler emits the rich approval card for these,
 * so the message-mapper drops any duplicate `tool.execution_*` events the
 * runtime may also emit for the same tool (see message-mapper.ts).
 */
export const COPILOT_INTERACTIVE_TOOL_NAMES = new Set(['ask_user', 'exit_plan_mode'])

/**
 * Extract the latest user message text. The Copilot session keeps full history
 * itself, so each turn only sends the new user prompt — prior turns are not
 * re-sent (mirrors how the cursor provider treats --resume).
 */
export function buildPrompt(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    return extractText(message.content)
  }
  // No user message (e.g. a continuation turn) — send an empty nudge.
  return ''
}

function extractText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim()
}
