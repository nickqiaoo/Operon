/**
 * What is left of the direct GitHub integration after PR creation moved to the
 * user's own `gh` login (gh-cli.ts): parsing owner/repo out of a git remote,
 * which is pure string work and needs no credentials.
 */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  if (!url) return null
  let cleaned = url.trim()
  if (cleaned.endsWith('.git')) cleaned = cleaned.slice(0, -4)

  const sshMatch = cleaned.match(/^git@github\.com:([^/]+)\/(.+)$/)
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] }

  const httpsMatch = cleaned.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)\/?$/)
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] }

  return null
}
