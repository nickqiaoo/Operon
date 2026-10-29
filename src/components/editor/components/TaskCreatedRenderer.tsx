import { useState } from 'react'
import { ClipboardList, ChevronRightIcon, Loader2, AlertCircle } from 'lucide-react'
import { useEditorStore } from '@/stores/editor-store'
import { api } from '@/lib/api'
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'
import {
  TASK_CREATING_TOOLS,
  asCreatedTaskRef,
  bareToolName,
  isOperonSpecTool,
  isSpecTaskTool,
  type CreatedTaskRef,
} from '@shared/taskboard/tools'
import { SpecChatCard } from '@/components/spec/SpecChatCard'
import { unwrapToolEnvelope, type ToolPartLike } from './toolName'

/**
 * Success line of a task-creating tool. Anchored on the verb so a FAILED call
 * ("Could not promote: Channel 1 does not have…") can never be mistaken for a
 * created task just because its text happens to contain a number.
 */
const CREATED_RE = /(?:Created task|Promoted to task)\s+#(\d+)/i

/**
 * The tool this part invoked, with the MCP client's `mcp__<server>__` prefix
 * removed.
 *
 * The envelope unwrap is load-bearing, not defensive: providers on the ACP path
 * (Grok, Cursor, …) route every call through a single generic tool and put the
 * real target in the arguments — `use_tool { tool_name: 'taskboard__create_spec_task',
 * tool_input: {...} }`. Reading `toolName` alone yields `use_tool` for those, so
 * a task created through them would never be recognised.
 */
export function toolNameOf(toolPart: ToolPartLike): string {
  const rawName =
    (toolPart as { toolName?: string }).toolName ??
    (toolPart as { type?: string }).type?.replace(/^tool-/, '') ??
    ''
  const rawInput = ((toolPart as { args?: unknown; input?: unknown }).args ??
    (toolPart as { input?: unknown }).input ??
    {}) as Record<string, unknown>
  return bareToolName(unwrapToolEnvelope(rawName, rawInput).toolName)
}

/** The call's arguments, past both the ACP envelope and the MCP gateway's nesting. */
function toolInputOf(toolPart: ToolPartLike): Record<string, unknown> {
  const rawInput = ((toolPart as { args?: unknown; input?: unknown }).args ??
    (toolPart as { input?: unknown }).input ??
    {}) as Record<string, unknown>
  const unwrapped = unwrapToolEnvelope(
    (toolPart as { toolName?: string }).toolName ?? '',
    rawInput,
  ).input
  return ((unwrapped.arguments as Record<string, unknown> | undefined) ?? unwrapped)
}

export function isTaskCreatedTool(toolPart: ToolPartLike): boolean {
  return TASK_CREATING_TOOLS.includes(toolNameOf(toolPart))
}

/**
 * Pull the text out of a tool result, whatever the provider wrapped it in. Seen in
 * real transcripts: a bare string, `{content:[{type:'text',text}]}`, the MCP
 * gateway's `{server,tool,result:{content:[{text}]}}`, and the ACP providers'
 * `{output:'…'}` — so unwrap recursively rather than guessing one depth.
 */
function extractText(value: unknown, depth = 0): string {
  if (depth > 4) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((v) => extractText(v, depth + 1)).filter(Boolean).join('\n')
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (record.content !== undefined) return extractText(record.content, depth + 1)
    if (record.result !== undefined) return extractText(record.result, depth + 1)
    if (record.output !== undefined) return extractText(record.output, depth + 1)
  }
  return ''
}

export function resultText(toolPart: ToolPartLike): string {
  const part = toolPart as { output?: unknown; result?: unknown }
  return extractText(part.output ?? part.result)
}

/**
 * The tool's machine-readable payload. Claude Code can surface an MCP
 * `outputSchema` result directly as the tool output, while other providers keep
 * it under `structuredContent`; the MCP gateway may add another `result` layer.
 */
function findStructured(value: unknown, depth = 0): unknown {
  if (depth > 4 || !value || typeof value !== 'object') return undefined
  const direct = asCreatedTaskRef(value)
  if (direct) return direct
  const record = value as Record<string, unknown>
  if (record.structuredContent !== undefined && record.structuredContent !== null) {
    return record.structuredContent
  }
  if (record.result !== undefined) return findStructured(record.result, depth + 1)
  return undefined
}

function createdTaskRef(toolPart: ToolPartLike): CreatedTaskRef | null {
  const part = toolPart as { output?: unknown; result?: unknown }
  return asCreatedTaskRef(findStructured(part.output ?? part.result))
}

/**
 * The task number this call created, or null when there is nothing to link to —
 * the call is still streaming, or it failed ("Could not promote: …").
 *
 * This is the single condition deciding whether the call renders as a card, and
 * it has two callers that must agree. {@link isCompactEligible} asks it to keep
 * a card-worthy call out of the collapsed work group; the renderer asks it
 * before drawing. If they disagreed, a call could be pulled out of the group and
 * then decline to render — vanishing from the transcript entirely.
 */
export function createdTaskNumber(toolPart: ToolPartLike): number | null {
  if (!isTaskCreatedTool(toolPart)) return null
  const ref = createdTaskRef(toolPart)
  const number = ref?.taskNumber ?? Number(CREATED_RE.exec(resultText(toolPart))?.[1] ?? NaN)
  return Number.isFinite(number) ? number : null
}

/**
 * Card for a task-creating tool call: shows the new task and jumps to its detail
 * page on click.
 *
 * Two sources, in order of preference:
 *  1. `structuredContent` — the tool states the taskId outright, so the click is
 *     a straight navigation.
 *  2. The prose, via {@link CREATED_RE} — for transcripts recorded before that
 *     payload existed, and providers that drop it. Prose only yields the
 *     per-project `#number`, so the click has to resolve number → id against the
 *     task list first. Resolution happens on click, not on render, to keep
 *     transcript rendering free of network calls.
 */
export function TaskCreatedRenderer({ toolPart }: { toolPart: ToolPartLike }) {
  const requestOpenTask = useEditorStore((s) => s.requestOpenTask)
  const projectId = useEditorStore((s) => s.currentProjectId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Preferred path: the tool told us exactly what it created. The regex below is
  // only a fallback for transcripts recorded before structuredContent was added,
  // and for providers that drop it on the way through.
  const ref = createdTaskRef(toolPart)
  const text = resultText(toolPart)
  const number = createdTaskNumber(toolPart)
  const input = toolInputOf(toolPart) as { title?: string }
  // "Created task #7: Fix the thing" / "Promoted to task #7 (branch …)"
  const title =
    ref?.title?.trim() ||
    input.title?.trim() ||
    text.match(/#\d+:\s*(.+)/)?.[1]?.trim() ||
    'Project task'
  const isSpec = ref?.sddManaged ?? isSpecTaskTool(toolNameOf(toolPart))

  // Still streaming, or the call failed — nothing to link to. `isCompactEligible`
  // asks the same question, so such a call stays in the collapsed work group and
  // never reaches this renderer; the guard is here to keep the two in step.
  if (number === null) return null

  // An OperonSpec gets the live card with its design gate. It needs the task id,
  // which only the structured payload carries; without it, the plain card below.
  if (ref && (ref.spec || isOperonSpecTool(toolNameOf(toolPart)))) {
    return <SpecChatCard taskId={ref.taskId} taskNumber={ref.taskNumber} title={title} />
  }

  const open = async () => {
    if (busy) return
    // Structured payload carries the database id — no lookup needed at all.
    if (ref && projectId != null) {
      requestOpenTask({ projectId, taskId: ref.taskId })
      return
    }
    if (projectId == null) return
    setBusy(true)
    setError(null)
    try {
      const { tasks } = await api.taskList(projectId, { includeArchived: true })
      const match = tasks.find((t) => t.number === number)
      if (!match) {
        setError(`Task #${number} was not found in this project.`)
        return
      }
      requestOpenTask({ projectId, taskId: match.id })
    } catch {
      setError('Could not open the task board.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Trace>
      <button type="button" onClick={() => void open()} disabled={projectId == null || busy} className="disabled:cursor-not-allowed">
        <TraceLine status={busy ? 'running' : undefined}>
          <TraceIcon><ClipboardList /></TraceIcon>
          <TraceTitle>{isSpec ? 'Created spec-driven task' : 'Created task'} {title}</TraceTitle>
          <TraceDescription className="font-mono">#{number}</TraceDescription>
          <TraceIcon>{busy ? <Loader2 className="animate-spin" /> : <ChevronRightIcon />}</TraceIcon>
        </TraceLine>
      </button>
      {error && (
        <div className="flex items-center gap-1.5 text-xs text-status-error">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
    </Trace>
  )
}
