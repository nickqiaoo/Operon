import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSubagentMessages } from '@anthropic-ai/claude-agent-sdk'
import type { RuntimeContext } from '../../context.js'

/**
 * One tool call a sub-agent made, shaped like the tool parts a sub-agent card
 * renders from a live turn — so a card can show either source the same way.
 */
export interface ClaudeSubagentStep {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  state: 'input-available' | 'output-available' | 'output-error'
  output?: unknown
  errorText?: string
}

export interface ClaudeSubagentTranscript {
  steps: ClaudeSubagentStep[]
  /** The sub-agent has written its final report. */
  finished: boolean
}

/**
 * Calls Claude Code makes on the sub-agent's behalf rather than steps it took —
 * `SubagentHandback` is how the finished agent hands its report back.
 */
const HANDBACK_TOOL = 'SubagentHandback'
const INTERNAL_TOOLS = new Set([HANDBACK_TOOL])

/** `<sessionId>` → the directory holding its `subagents/`, once found. */
const sessionDirs = new Map<string, string>()

function claudeConfigDir(ctx: RuntimeContext): string {
  const configured = ctx.env().CLAUDE_CONFIG_DIR
  return configured || join(homedir(), '.claude')
}

/**
 * Where Claude Code keeps a session's sub-agent transcripts:
 * `<config>/projects/<project>/<sessionId>/subagents/`. The project folder is a
 * mangled cwd (long ones are hashed), so rather than re-derive it, look for the
 * session under every project — session ids are unique.
 */
async function findSubagentsDir(ctx: RuntimeContext, sessionId: string): Promise<string | undefined> {
  const cached = sessionDirs.get(sessionId)
  if (cached && existsSync(cached)) return cached
  const projectsDir = join(claudeConfigDir(ctx), 'projects')
  let projects: string[]
  try {
    projects = await readdir(projectsDir)
  } catch {
    return undefined
  }
  for (const project of projects) {
    const dir = join(projectsDir, project, sessionId, 'subagents')
    if (existsSync(dir)) {
      sessionDirs.set(sessionId, dir)
      return dir
    }
  }
  return undefined
}

/**
 * The sub-agent spawned by tool call `toolUseId`. Each transcript sits beside an
 * `agent-<id>.meta.json` that names the spawning call, which is the only link
 * from a card back to its transcript that survives a restart.
 */
async function findAgentId(dir: string, toolUseId: string): Promise<string | undefined> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return undefined
  }
  for (const file of files) {
    const match = /^agent-(.+)\.meta\.json$/.exec(file)
    if (!match) continue
    try {
      const meta = JSON.parse(await readFile(join(dir, file), 'utf8')) as { toolUseId?: unknown }
      if (meta.toolUseId === toolUseId) return match[1]
    } catch {
      // A meta file being written right now; the next read will see it.
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function contentBlocks(message: unknown): Record<string, unknown>[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return []
  return message.content.filter(isRecord)
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/**
 * Read the steps of the sub-agent spawned by `toolUseId` in Claude session
 * `sessionId`. Null when there is no such transcript (yet).
 */
export async function readClaudeSubagentTranscript(
  ctx: RuntimeContext,
  sessionId: string,
  toolUseId: string,
): Promise<ClaudeSubagentTranscript | null> {
  const dir = await findSubagentsDir(ctx, sessionId)
  if (!dir) return null
  const agentId = await findAgentId(dir, toolUseId)
  if (!agentId) return null

  const messages = await getSubagentMessages(sessionId, agentId)
  const steps: ClaudeSubagentStep[] = []
  const byId = new Map<string, ClaudeSubagentStep>()
  let finished = false

  for (const entry of messages) {
    const blocks = contentBlocks(entry.message)
    if (entry.type === 'assistant') {
      let calledTool = false
      let handedBack = false
      for (const block of blocks) {
        if (block.type !== 'tool_use' || typeof block.id !== 'string') continue
        if (block.name === HANDBACK_TOOL) handedBack = true
        if (typeof block.name === 'string' && INTERNAL_TOOLS.has(block.name)) continue
        calledTool = true
        const step: ClaudeSubagentStep = {
          toolCallId: block.id,
          toolName: typeof block.name === 'string' ? block.name : 'unknown-tool',
          input: isRecord(block.input) ? block.input : {},
          state: 'input-available',
        }
        steps.push(step)
        byId.set(step.toolCallId, step)
      }
      // The final report is either handed back through the tool or, from older
      // CLIs, a reply with text and no tool call.
      finished = handedBack || (!calledTool && blocks.some((block) => block.type === 'text'))
      continue
    }
    if (entry.type === 'user') {
      for (const block of blocks) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        const step = byId.get(block.tool_use_id)
        if (!step) continue
        const text = toolResultText(block.content)
        if (block.is_error === true) {
          step.state = 'output-error'
          step.errorText = text
        } else {
          step.state = 'output-available'
          step.output = text
        }
      }
    }
  }

  return { steps, finished }
}
