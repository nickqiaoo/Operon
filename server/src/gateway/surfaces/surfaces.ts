import {
  addAgentSessionLink,
  createAgentActivity,
  type LinearActivityContent,
} from '../../services/integrations/linear-app.js'
import {
  createIssueComment,
  replyToReviewComment,
  type RepoRef,
} from '../../services/integrations/github-app.js'

// The two surfaces: what the bridge's calls become on each platform
// (docs/linear-github/design.md §9, after operon-agents/examples/linear-github).
//
// Linear has a vocabulary for exactly this — agent activities: thought,
// action, response, elicitation, error — so each call is one activity, and a
// PR becomes an external link on the session. GitHub has comments: thoughts
// and tool calls accumulate and ride inside the next comment as a collapsed
// trace, so a review thread gets one reply per turn, not one per step.

/** One tool call as the surfaces show it: started, then finished with a short result. */
export interface ToolTrace {
  id: string
  name: string
  /** A short extract of the input: the command, the path, the query. May be empty. */
  hint: string
  status: 'running' | 'done' | 'error'
  /** Finished calls only: the first lines of the result. */
  result?: string
}

export interface Surface {
  readonly kind: 'linear_session' | 'github_pr'
  readonly ref: string
  /** "I'm on it": Linear marks a session unresponsive without a sign of life within seconds. */
  ack(status: string): Promise<void>
  /** Interim assistant text — what the model said before calling tools. */
  thought(markdown: string): Promise<void>
  action(call: ToolTrace): Promise<void>
  /** The turn's final text. */
  respond(markdown: string): Promise<void>
  /** The turn paused on a question; the next reply on the surface answers it. */
  ask(markdown: string): Promise<void>
  error(markdown: string): Promise<void>
  /** A resource the turn produced (the pull request). */
  link(label: string, url: string): Promise<void>
}

/** Activities per turn before actions go ephemeral-only (design §9). */
const LINEAR_ACTIVITY_CAP = 40

export class LinearSurface implements Surface {
  readonly kind = 'linear_session' as const
  private count = 0

  constructor(
    private readonly orgId: string,
    readonly ref: string, // agent session id
  ) {}

  private activity(content: LinearActivityContent, ephemeral = false): Promise<void> {
    if (!ephemeral) this.count += 1
    return createAgentActivity(this.orgId, this.ref, content, ephemeral)
  }

  resetTurn(): void {
    this.count = 0
  }

  ack(status: string): Promise<void> {
    return this.activity({ type: 'thought', body: status }, true)
  }

  thought(markdown: string): Promise<void> {
    if (this.count >= LINEAR_ACTIVITY_CAP) return this.activity({ type: 'thought', body: markdown }, true)
    return this.activity({ type: 'thought', body: markdown })
  }

  action(call: ToolTrace): Promise<void> {
    if (call.status === 'running') {
      // Ephemeral: replaced by the next activity, so a long command shows as in
      // progress without leaving a permanent "started" line behind the finished one.
      return this.activity({ type: 'action', action: call.name, parameter: call.hint }, true)
    }
    const result = call.result
      ? call.status === 'error'
        ? `✗ ${call.result}`
        : call.result
      : call.status === 'error'
        ? '✗ failed'
        : 'done'
    return this.activity(
      { type: 'action', action: call.name, parameter: call.hint, result },
      this.count >= LINEAR_ACTIVITY_CAP,
    )
  }

  respond(markdown: string): Promise<void> {
    return this.activity({ type: 'response', body: markdown })
  }

  ask(markdown: string): Promise<void> {
    return this.activity({ type: 'elicitation', body: markdown })
  }

  error(markdown: string): Promise<void> {
    return this.activity({ type: 'error', body: markdown })
  }

  link(label: string, url: string): Promise<void> {
    return addAgentSessionLink(this.orgId, this.ref, { label, url })
  }
}

function traceLine(call: ToolTrace): string {
  const mark = call.status === 'running' ? '…' : call.status === 'error' ? '✗' : '✓'
  return `${mark} ${call.name}${call.hint ? `: ${call.hint}` : ''}`
}

export interface GitHubReplyTarget {
  /** A review comment to reply under; absent = the PR conversation. */
  reviewCommentId?: number
}

export class GitHubSurface implements Surface {
  readonly kind = 'github_pr' as const
  readonly ref: string
  private thoughts: string[] = []
  private calls = new Map<string, ToolTrace>()

  constructor(
    private readonly repo: RepoRef,
    private readonly prNumber: number,
    private target: GitHubReplyTarget = {},
  ) {
    this.ref = `${repo.owner}/${repo.name}#${prNumber}`
  }

  setTarget(target: GitHubReplyTarget): void {
    this.target = target
  }

  private post(markdown: string): Promise<unknown> {
    if (this.target.reviewCommentId) {
      return replyToReviewComment(this.repo, this.prNumber, this.target.reviewCommentId, markdown)
    }
    return createIssueComment(this.repo, this.prNumber, markdown)
  }

  private flush(body: string): Promise<unknown> {
    const calls = [...this.calls.values()]
    const thoughts = this.thoughts
    this.calls = new Map()
    this.thoughts = []
    if (calls.length === 0 && thoughts.length === 0) return this.post(body)
    const trace = [
      ...thoughts.map((t) => `> ${t.replace(/\n/g, '\n> ')}`),
      ...(calls.length > 0 ? ['```', ...calls.map(traceLine), '```'] : []),
    ].join('\n\n')
    const summary = `${calls.length} tool call${calls.length === 1 ? '' : 's'}`
    return this.post(`${body}\n\n<details>\n<summary>Trace: ${summary}</summary>\n\n${trace}\n\n</details>`)
  }

  resetTurn(): void {
    this.thoughts = []
    this.calls = new Map()
  }

  async ack(): Promise<void> {
    // A PR comment has no typing indicator; the reply is the acknowledgment.
  }

  async thought(markdown: string): Promise<void> {
    this.thoughts.push(markdown)
  }

  async action(call: ToolTrace): Promise<void> {
    this.calls.set(call.id, call)
  }

  async respond(markdown: string): Promise<void> {
    await this.flush(markdown)
  }

  async ask(markdown: string): Promise<void> {
    await this.flush(`❓ ${markdown}`)
  }

  async error(markdown: string): Promise<void> {
    await this.flush(`⚠️ ${markdown}`)
  }

  async link(): Promise<void> {
    // The PR is where we are.
  }
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// "Bash: git status" reads better than "Bash". Tool inputs are free-form JSON;
// pull the first human-meaningful field.
export function hintOf(input: unknown): string {
  const args = input as Record<string, unknown> | null | undefined
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'branch', 'title', 'task', 'questions']) {
    const value = args?.[key]
    if (typeof value === 'string' && value) return truncate(value.replace(/\s+/g, ' '), 120)
    if (typeof value === 'number') return String(value)
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0] as { question?: unknown } | undefined
      if (typeof first?.question === 'string') return truncate(first.question, 120)
    }
  }
  return ''
}

export function resultTextOf(output: unknown): string {
  if (typeof output === 'string') return output.trim()
  if (output && typeof output === 'object') {
    const content = (output as { content?: unknown }).content
    if (Array.isArray(content)) {
      return content
        .filter((p): p is { type: 'text'; text: string } => (p as { type?: string })?.type === 'text' && typeof (p as { text?: unknown }).text === 'string')
        .map((p) => p.text)
        .join('')
        .trim()
    }
    try {
      return JSON.stringify(output).trim()
    } catch {
      return ''
    }
  }
  return output == null ? '' : String(output)
}

/** The first pull request URL in a text, if any. */
export function pullRequestUrlIn(text: string): string | undefined {
  return /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.exec(text)?.[0]
}
