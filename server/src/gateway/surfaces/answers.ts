import type { SurfacePending } from '../../types/task.js'
import type { PermissionOutcome } from '../../services/ai/types.js'

// A paused turn, in words — and a reply, back into answers
// (docs/linear-github/design.md §8.2, after the example's answers.ts).
//
// The agent pauses for two reasons: it asked something (AskUserQuestion) or a
// tool needs approval. Both become one message on the surface, and the next
// reply there from the task's owner answers all of it. Replies are prose:
// Linear and GitHub have no option buttons, so a question's answer is
// whatever the person wrote, and an approval is read off the first word.

interface QuestionItem {
  question: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

export function isAskUserTool(toolName: string): boolean {
  return toolName === 'AskUserQuestion' || toolName === 'ask_user'
}

function questionsOf(pending: SurfacePending): QuestionItem[] {
  if (!isAskUserTool(pending.toolName)) return []
  const questions = pending.input.questions
  return Array.isArray(questions)
    ? (questions as QuestionItem[]).filter((q) => typeof q?.question === 'string')
    : []
}

function summarizeInput(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'title']) {
    const v = input[key]
    if (typeof v === 'string' && v) return v.length > 160 ? `${v.slice(0, 160)}…` : v
  }
  return ''
}

/** The surface message for a paused turn. */
export function renderPending(pending: readonly SurfacePending[]): string {
  const blocks: string[] = []
  let n = 0
  for (const entry of pending) {
    const questions = questionsOf(entry)
    if (questions.length === 0) {
      const detail = summarizeInput(entry.input)
      blocks.push(`**Approval needed:** \`${entry.toolName}\`${detail ? ` — \`${detail}\`` : ''}`)
      continue
    }
    for (const q of questions) {
      n += 1
      const header = q.header ? ` (${q.header})` : ''
      const lines = [`**Question ${n}${header}:** ${q.question}`]
      for (const option of q.options ?? []) {
        lines.push(`- **${option.label}**${option.description ? ` — ${option.description}` : ''}`)
      }
      if (q.multiSelect) lines.push('_(more than one may apply)_')
      blocks.push(lines.join('\n'))
    }
  }
  const approvals = pending.some((entry) => questionsOf(entry).length === 0)
  const questions = pending.some((entry) => questionsOf(entry).length > 0)
  const footer = approvals
    ? questions
      ? 'Reply here: start with `approve` or `reject`, then answer the questions in your own words.'
      : 'Reply `approve` or `reject`; anything after the word is passed on as your reason.'
    : 'Reply here. Free text is fine.'
  return `${blocks.join('\n\n')}\n\n${footer}`
}

// `\b` is ASCII-only, so a Chinese verb at the end of the line never matches
// it; "not followed by a word character" is what the boundary meant anyway.
const APPROVE = /^\s*(approve[d]?|yes|ok(ay)?|lgtm|go( ahead)?|proceed|批准|同意|可以|好的?)(?![A-Za-z0-9_])/i
const REJECT = /^\s*(reject(ed)?|no(pe)?|deny|denied|don'?t|stop|拒绝|不行|不要|别)(?![A-Za-z0-9_])/i

/**
 * The reply, routed to every pending entry. Unclear approvals are rejections
 * with the reply as feedback: the agent reads why and can ask again, whereas
 * a guessed approval cannot be undone.
 */
export function answersFor(
  pending: readonly SurfacePending[],
  reply: string,
): Array<{ approvalId: string; chatId: number; outcome: PermissionOutcome }> {
  const text = reply.trim()
  const out: Array<{ approvalId: string; chatId: number; outcome: PermissionOutcome }> = []
  for (const entry of pending) {
    const questions = questionsOf(entry)
    if (questions.length === 0) {
      const approved = APPROVE.test(text)
      const feedback = text
        .replace(approved ? APPROVE : REJECT, '')
        .replace(/^[\s:,.-]+/, '')
        .trim()
      out.push({
        approvalId: entry.approvalId,
        chatId: entry.chatId,
        outcome: approved
          ? { outcome: 'allow' }
          : { outcome: 'deny', reason: feedback || 'Rejected from the issue thread.' },
      })
      continue
    }
    // A question's answer is keyed by its text (the AskUserQuestion contract);
    // with no option buttons every question gets the whole reply.
    const answers = Object.fromEntries(questions.map((q) => [q.question, text]))
    out.push({
      approvalId: entry.approvalId,
      chatId: entry.chatId,
      outcome: { outcome: 'allow', updatedInput: { questions, answers, method: 'freeform' } },
    })
  }
  return out
}
