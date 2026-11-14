import { useEffect } from 'react'
import { ChevronRightIcon, GitBranch } from 'lucide-react'
import { FormattedMessage, useIntl } from 'react-intl'
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'
import { activateWorkspace, ensureWorkspaceKnown } from '@/lib/workspace-nav'
import { resultText, toolNameOf } from './TaskCreatedRenderer'
import type { ToolPartLike } from './toolName'

export interface CreatedWorkspace {
  workspaceId: number
  name: string
  branch: string
}

/**
 * The workspace `workspace_create` (on the external_agent server) made, or null while it
 * streams, when it failed, or for another server's tool of the same name (the
 * assistant's answers in prose). One condition for both the renderer and
 * `isCompactEligible`, so a call is never pulled out of the work group and then
 * declines to draw.
 */
export function createdWorkspace(toolPart: ToolPartLike): CreatedWorkspace | null {
  // `mcp__external_agent__workspace_create`, OpenCode's `external_agent_workspace_create`, a bare name.
  if (!/(^|[_.])workspace_create$/.test(toolNameOf(toolPart))) return null
  const text = resultText(toolPart).trim()
  if (!text.startsWith('{')) return null
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const { workspace_id: id, name, branch } = parsed
    if (typeof id !== 'number' || typeof name !== 'string') return null
    return { workspaceId: id, name, branch: typeof branch === 'string' ? branch : name }
  } catch {
    return null
  }
}

/** A new workspace from a conversation: shows its branch, and opens it. */
export function WorkspaceCreatedRenderer({ workspace }: { workspace: CreatedWorkspace }) {
  const intl = useIntl()
  // The sidebar has not heard of it yet; nothing else tells it.
  useEffect(() => { void ensureWorkspaceKnown(workspace.workspaceId) }, [workspace.workspaceId])
  const openLabel = intl.formatMessage({ id: 'editor.workspaceCreated.open', defaultMessage: 'Open workspace' })

  return (
    <Trace>
      <button type="button" onClick={() => void activateWorkspace(workspace.workspaceId)} aria-label={openLabel} title={openLabel}>
        <TraceLine>
          <TraceIcon><GitBranch /></TraceIcon>
          <TraceTitle>
            <FormattedMessage
              id="editor.workspaceCreated.title"
              defaultMessage="Created workspace {name}"
              values={{ name: workspace.name }}
            />
          </TraceTitle>
          <TraceDescription className="min-w-0 shrink truncate font-mono">{workspace.branch}</TraceDescription>
          <TraceIcon><ChevronRightIcon /></TraceIcon>
        </TraceLine>
      </button>
    </Trace>
  )
}
