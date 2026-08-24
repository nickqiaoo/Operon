// Interactive CLI command launched in a Terminal tab, per runtime provider.
// A provider is offered in the "New Terminal" menu only if it appears here, so
// API-only providers (e.g. `custom`) — which have no interactive CLI — are
// omitted. The command is run in the workspace cwd by the terminal; if it isn't
// on PATH the terminal surfaces the usual "command not found".
export const TERMINAL_CLI_LAUNCH: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  copilot: 'copilot',
  cursor: 'cursor-agent',
  gemini: 'gemini',
  opencode: 'opencode',
  kimi: 'kimi',
  grok: 'grok',
}

/** Whether the given provider can be opened as a terminal. */
export function hasTerminalCli(providerId: string): boolean {
  return providerId in TERMINAL_CLI_LAUNCH
}
