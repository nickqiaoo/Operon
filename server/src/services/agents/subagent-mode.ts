/**
 * The permission mode every autonomous sub-agent runs in.
 *
 * A sub-agent (workflow `agent()`, external-agent spawn) has no human sitting in
 * front of it. Any mode that stops to ask stalls the agent until something else
 * rescues it, so each provider gets its NON-INTERACTIVE mode here — deliberately
 * the most permissive one it offers.
 *
 * That is a real trade-off, chosen knowingly: a sub-agent can write outside the
 * workspace. It is not a licence to skip supervision — the safety net is that
 * requests which still reach a human (`AskUserQuestion` is NOT suppressed by any
 * mode, and a few providers ask regardless) get bubbled up to the launching
 * conversation, and anything unanswered is auto-denied rather than left hanging.
 * See the workflow MCP route for how this is dispatched.
 *
 * WHY A TABLE, AND WHY IT THROWS: this replaces a `switch` whose `default` branch
 * invented mode ids (`'fullAccess'` / `'default'`) for providers that never had
 * them. `custom` accepts only manual/workspace/auto/yolo, so the invented id fell
 * through `MODE_TO_PERMISSION[modeId] ?? 'manual'` and every sub-agent silently
 * ran in the ask-before-every-write mode — the exact mode that cannot work
 * headless. Guessing an id is worse than failing, so an unregistered provider is
 * an error: it surfaces as one failed sub-agent with a clear message instead of a
 * run that hangs forever.
 *
 * Ids are verified against each provider's own `modes` list; keep them in sync
 * when a provider changes its modes.
 */
const SUBAGENT_MODE: Record<string, string> = {
  // manual | workspace | auto | yolo          (services/operon-runtime/index.ts)
  custom: 'yolo',
  // default | auto | acceptEdits | plan | bypassPermissions   (providers/claude/config.ts)
  'claude-code': 'bypassPermissions',
  // requestApproval | approveForMe | fullAccess | plan        (providers/codex/index.ts)
  codex: 'fullAccess',
  // Default | AutoEdit | FullAccess                           (providers/gemini/index.ts)
  gemini: 'FullAccess',
  // default | plan | auto | yolo                              (providers/kimi/config.ts)
  kimi: 'yolo',
  // build | plan | fullAccess                                 (providers/opencode/index.ts)
  opencode: 'fullAccess',
  // agent | plan | ask — no approval mode exists; `agent` is the working one.
  cursor: 'agent',
  // interactive | plan | autopilot                            (providers/copilot/config.ts)
  copilot: 'autopilot',
}

/**
 * Resolve the mode an autonomous sub-agent runs in on `providerId`.
 *
 * Throws for an unregistered provider — see the note above on why this must not
 * fall back to a guess.
 */
export function subagentMode(providerId: string): string {
  const mode = SUBAGENT_MODE[providerId]
  if (!mode) {
    throw new Error(
      `No sub-agent permission mode registered for provider '${providerId}'. ` +
        `Add it to SUBAGENT_MODE (server/src/services/agents/subagent-mode.ts) using one of that ` +
        `provider's own mode ids — sub-agents run unattended, so the mode must not prompt.`,
    )
  }
  return mode
}

/** Providers that can host a sub-agent. Exported for tests and tooling. */
export function subagentCapableProviders(): string[] {
  return Object.keys(SUBAGENT_MODE)
}
