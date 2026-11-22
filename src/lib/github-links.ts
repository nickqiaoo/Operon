/** A GitHub pull request or issue that a bare URL in markdown points at. */
export interface GithubLinkRef {
  url: string
  owner: string
  repo: string
  kind: 'pull' | 'issue'
  number: number
}

// The PR / issue URL itself, plus an optional sub-page (`/files`) and fragment (`#issuecomment-1`).
const GITHUB_LINK_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?:\/[\w./-]*)?(?:#[\w-]*)?/

/**
 * Reads a GitHub PR / issue URL from the start of `text`. Returns the matched
 * reference and whatever follows it: a CJK autolink swallows the sentence after
 * the URL (`…/pull/1这个链接`), and that tail must stay plain text.
 */
export function matchGithubLink(text: string): { ref: GithubLinkRef; rest: string } | null {
  const m = GITHUB_LINK_RE.exec(text)
  if (!m) return null
  const rest = text.slice(m[0].length)
  // Anything ASCII right after the match means the URL goes on (`/pull/1abc`, `?diff=split`): not ours.
  if (rest && /^[\x21-\x7e]/.test(rest)) return null
  return {
    ref: { url: m[0], owner: m[1], repo: m[2], kind: m[3] === 'pull' ? 'pull' : 'issue', number: Number(m[4]) },
    rest,
  }
}

/** `owner/repo#12`, lower-cased: how a task's PR surface names its pull request. */
export function githubLinkKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`.toLowerCase()
}
