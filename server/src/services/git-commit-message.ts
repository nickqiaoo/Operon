import { randomUUID } from 'node:crypto'
import { getSessionManager } from './ai.js'
import { runAgentTurn } from './ai/agent-turn.js'
import { extractAssistantText } from './ai/message-utils.js'
import { getCommitMessageConfig } from './commit-message-config.js'
import { getStatus, getDiff } from './git.js'

const MAX_DIFF_CHARS = 24_000

const RULES = [
  'Output ONLY a single Conventional Commits message — no explanation, no code fences, no surrounding quotes.',
  'Format: `<type>(<optional scope>): <subject>` — lowercase subject, imperative mood, ≤72 chars, no trailing period.',
  'If multiple notable changes, add a blank line then short `- bullet` body lines.',
  'English only.',
  'Do NOT call any tools — base the message solely on the diff provided below.',
].join('\n- ')

/**
 * Build the diff context inline so the model never needs to run git tools:
 * prefer the staged diff (what a plain commit would record); fall back to the
 * unstaged diff plus untracked file names when nothing is staged.
 */
async function buildDiffContext(repoPath: string): Promise<string> {
  const status = await getStatus(repoPath)
  const hasStaged = status.staged.length > 0

  let diff = hasStaged ? await getDiff(repoPath, undefined, true) : await getDiff(repoPath, undefined, false)
  diff = diff.trim()

  const sections: string[] = []
  if (diff.length > 0) {
    sections.push(`# ${hasStaged ? 'Staged' : 'Unstaged'} diff\n${diff}`)
  }
  if (!hasStaged && status.untracked.length > 0) {
    sections.push(`# Untracked files\n${status.untracked.map((f) => f.path).join('\n')}`)
  }

  let context = sections.join('\n\n')
  if (context.length > MAX_DIFF_CHARS) {
    context = `${context.slice(0, MAX_DIFF_CHARS)}\n…(diff truncated)`
  }
  return context
}

/** Strip code fences / wrapping quotes a model sometimes adds around the message. */
function cleanMessage(raw: string): string {
  return raw
    .trim()
    .replace(/^```[\w-]*\n?|\n?```$/g, '')
    .replace(/^["'`]|["'`]$/g, '')
    .trim()
}

export async function generateCommitMessage(repoPath: string, signal?: AbortSignal): Promise<string> {
  const config = getCommitMessageConfig()
  const providerId = config.providerId || 'claude'
  const modelId = config.modelId || undefined

  const diffContext = await buildDiffContext(repoPath)
  if (diffContext.length === 0) {
    throw new Error('No changes to summarize')
  }

  const prompt = `Generate a git commit message for the changes below.\n\nRules:\n- ${RULES}\n\n${diffContext}`

  const manager = getSessionManager()
  const session = await manager.createStandaloneSession(providerId, {
    cwd: repoPath,
    providerId,
    modelId,
  })

  try {
    // Same shared turn core as chat/workflow — assemble the final assistant
    // message, then read its text. The prompt forbids tool calls, so the
    // assembled message is a single text block.
    const { preparedParts, done } = runAgentTurn(session, {
      requestId: randomUUID(),
      messages: [{ role: 'user', content: prompt }],
      signal: signal ?? new AbortController().signal,
      assistantMessageId: randomUUID(),
      originalMessages: [],
    })
    void preparedParts.cancel() // no live consumer here; only `done` is needed

    const { message } = await done
    const cleaned = cleanMessage(extractAssistantText(message))
    if (!cleaned) throw new Error('Model returned an empty commit message')
    return cleaned
  } finally {
    await session.dispose().catch(() => {})
  }
}
