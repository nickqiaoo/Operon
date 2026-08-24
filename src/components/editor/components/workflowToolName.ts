/**
 * Our MCP tool's name, and the one it used to have.
 *
 * `RunWorkflow` was renamed to `OperonWorkflow` because it sat one synonym away
 * from the `Workflow` tool several host agents ship built in. The old name stays
 * recognised forever: it is written into the transcript of every run made before
 * the rename, and dropping it would relabel all of those as the host agent's own.
 */
const OPERON_TOOL_NAMES = new Set(['operonworkflow', 'runworkflow'])

/** Last path-ish segment, lowercased — MCP tools arrive namespaced, and variously. */
function bareName(name: string): string | undefined {
  return name
    .replace(/^tool-/, '')
    .split(/[_.:/-]+/)
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase()
}

/** Recognize both a host agent's built-in workflow tool and our own MCP tool. */
export function isWorkflowToolName(name: string): boolean {
  const bare = bareName(name)
  return bare === 'workflow' || (bare !== undefined && OPERON_TOOL_NAMES.has(bare))
}

/**
 * Is this OUR workflow (`OperonWorkflow`), as opposed to the host agent's own?
 *
 * Several coding agents ship a built-in orchestration tool named `Workflow`, and
 * a model with both available will sometimes reach for theirs. That run lives
 * entirely inside the host agent — no runId of ours, nothing in the Workflows
 * panel, no result delivered back here. Both still render as a workflow card,
 * but the card has to say which is which, or the user goes looking in a panel
 * that will never show it.
 */
export function isOperonWorkflowTool(name: string): boolean {
  const bare = bareName(name)
  return bare !== undefined && OPERON_TOOL_NAMES.has(bare)
}
