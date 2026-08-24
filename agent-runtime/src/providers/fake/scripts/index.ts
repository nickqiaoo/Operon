import { FakeRuntimeProvider, setBuiltinScriptInstaller, type FakeScript } from '../index.js'
import { echoScript, splitTextScript, slowStreamScript } from './basics.js'
import {
  claudeTextOnly,
  claudeToolCall,
  claudePermission,
  claudeReasoning,
  claudeError,
  claudeMultiTurn,
  claudePlan,
  claudeEditDiff,
  claudeWriteDiff,
  claudeAskUserQuestion,
  claudeSubAgent,
} from './claude-style.js'
import {
  codexTextOnly,
  codexToolCall,
  codexPermission,
  codexReasoning,
  codexError,
  codexMultiTurn,
  codexPatchDiff,
  codexPlanSteps,
} from './codex-style.js'
import {
  geminiTextOnly,
  geminiToolCall,
  geminiPermission,
  geminiReasoning,
  geminiError,
  geminiMultiTurn,
  geminiPlan,
} from './gemini-style.js'
import {
  kimiTextOnly,
  kimiToolCall,
  kimiPermission,
  kimiReasoning,
  kimiError,
  kimiMultiTurn,
} from './kimi-style.js'
import {
  opencodeTextOnly,
  opencodeToolCall,
  opencodePermission,
  opencodeReasoning,
  opencodeError,
  opencodeMultiTurn,
  opencodeTodoWrite,
} from './opencode-style.js'
import {
  customTextOnly,
  customToolCall,
  customPermission,
  customReasoning,
  customError,
  customMultiTurn,
} from './custom-style.js'
import { blockingPermission, verbatimEcho, longRunning, toolOutputDenied, compactToolGroup } from './scenarios.js'

const BUILTIN_SCRIPTS: Record<string, FakeScript> = {
  // basics
  'echo': echoScript,
  'split-text': splitTextScript,
  'slow-stream': slowStreamScript,

  // claude-style
  'claude-text-only': claudeTextOnly,
  'claude-tool-call': claudeToolCall,
  'claude-permission': claudePermission,
  'claude-reasoning': claudeReasoning,
  'claude-error': claudeError,
  'claude-multi-turn': claudeMultiTurn,
  'claude-plan': claudePlan,
  'claude-edit-diff': claudeEditDiff,
  'claude-write-diff': claudeWriteDiff,
  'claude-ask-user-question': claudeAskUserQuestion,
  'claude-sub-agent': claudeSubAgent,

  // codex-style
  'codex-text-only': codexTextOnly,
  'codex-tool-call': codexToolCall,
  'codex-permission': codexPermission,
  'codex-reasoning': codexReasoning,
  'codex-error': codexError,
  'codex-multi-turn': codexMultiTurn,
  'codex-patch-diff': codexPatchDiff,
  'codex-plan-steps': codexPlanSteps,

  // gemini-style
  'gemini-text-only': geminiTextOnly,
  'gemini-tool-call': geminiToolCall,
  'gemini-permission': geminiPermission,
  'gemini-reasoning': geminiReasoning,
  'gemini-error': geminiError,
  'gemini-multi-turn': geminiMultiTurn,
  'gemini-plan': geminiPlan,

  // kimi-style
  'kimi-text-only': kimiTextOnly,
  'kimi-tool-call': kimiToolCall,
  'kimi-permission': kimiPermission,
  'kimi-reasoning': kimiReasoning,
  'kimi-error': kimiError,
  'kimi-multi-turn': kimiMultiTurn,

  // opencode-style
  'opencode-text-only': opencodeTextOnly,
  'opencode-tool-call': opencodeToolCall,
  'opencode-permission': opencodePermission,
  'opencode-reasoning': opencodeReasoning,
  'opencode-error': opencodeError,
  'opencode-multi-turn': opencodeMultiTurn,
  'opencode-todo-write': opencodeTodoWrite,

  // custom-style
  'custom-text-only': customTextOnly,
  'custom-tool-call': customToolCall,
  'custom-permission': customPermission,
  'custom-reasoning': customReasoning,
  'custom-error': customError,
  'custom-multi-turn': customMultiTurn,

  // generic scenarios
  'blocking-permission': blockingPermission,
  'verbatim-echo': verbatimEcho,
  'long-running': longRunning,
  'tool-output-denied': toolOutputDenied,
  'compact-tool-group': compactToolGroup,
}

/** Names of all built-in scripts, exported for tests and the /api/test/fake/scripts route. */
export const BUILTIN_SCRIPT_NAMES = Object.keys(BUILTIN_SCRIPTS) as ReadonlyArray<string>

export function installBuiltinScripts(): void {
  for (const [name, script] of Object.entries(BUILTIN_SCRIPTS)) {
    FakeRuntimeProvider.scripts.set(name, script)
  }
}

setBuiltinScriptInstaller(installBuiltinScripts)
