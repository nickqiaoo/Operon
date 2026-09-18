import { runOneShotPrompt } from './ai/one-shot.js'
import { getCommitMessageConfig } from './commit-message-config.js'
import { getFileDiffRange, getMergeBase, getStatus, listCommitSubjectsSince } from './git.js'

const MAX_DIFF_CHARS = 24_000

const RULES = [
  'Output EXACTLY this shape and nothing else:\nTITLE: <one line>\nBODY:\n<markdown body>',
  'TITLE follows Conventional Commits (`<type>(<optional scope>): <subject>`) — lowercase subject, imperative mood, ≤72 chars, no trailing period.',
  'BODY is GitHub-flavored markdown: one short summary paragraph, then a `## Changes` list of terse bullets. Call out anything a reviewer must look at closely.',
  'Describe only what the diff shows. Never claim tests were run or invent context you cannot see.',
  'English only. No code fences around the output.',
  'Do NOT call any tools — base the summary solely on the diff provided below.',
].join('\n- ')

export interface PrSummary {
  title: string
  body: string
}

/**
 * Resolve the ref the PR will be diffed against. The remote-tracking ref is
 * preferred (that's what GitHub compares to); fall back to the local branch,
 * then to nothing — a base that shares no history with HEAD would make the
 * whole repo look like the change.
 */
async function resolveBaseRef(repoPath: string, baseBranch: string): Promise<string | null> {
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    const mergeBase = await getMergeBase(repoPath, ref)
    if (mergeBase) return mergeBase
  }
  return null
}

/**
 * Everything the PR would contain: the patch from the base to the working tree
 * (the create-PR flow commits pending changes too, so they belong in the
 * summary), plus the subjects of the commits already made on this branch.
 */
async function buildPrContext(repoPath: string, baseBranch: string): Promise<string> {
  const baseRef = await resolveBaseRef(repoPath, baseBranch)
  const sections: string[] = []

  if (baseRef) {
    const subjects = await listCommitSubjectsSince(repoPath, baseRef)
    if (subjects.length > 0) {
      sections.push(`# Commits on this branch\n${subjects.map((s) => `- ${s}`).join('\n')}`)
    }
  }

  // headRef null = working tree, so uncommitted edits are included.
  const diff = baseRef ? (await getFileDiffRange(repoPath, undefined, baseRef, null)).trim() : ''
  if (diff.length > 0) {
    sections.push(`# Diff against ${baseBranch}\n${diff}`)
  }

  const status = await getStatus(repoPath)
  if (status.untracked.length > 0) {
    sections.push(`# New files\n${status.untracked.map((f) => f.path).join('\n')}`)
  }

  let context = sections.join('\n\n')
  if (context.length > MAX_DIFF_CHARS) {
    context = `${context.slice(0, MAX_DIFF_CHARS)}\n…(diff truncated)`
  }
  return context
}

/** Strip code fences the model sometimes wraps the whole answer in. */
function stripFences(raw: string): string {
  return raw.trim().replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '').trim()
}

/**
 * Parse the `TITLE:` / `BODY:` shape, degrading to "first line is the title,
 * rest is the body" when the model ignores the markers.
 */
function parseSummary(raw: string): PrSummary {
  const text = stripFences(raw)
  const titleMatch = text.match(/^[ \t]*TITLE:[ \t]*(.+)$/m)
  const bodyMatch = text.match(/^[ \t]*BODY:[ \t]*\r?\n?/m)

  if (titleMatch && bodyMatch?.index != null) {
    return {
      title: titleMatch[1].trim(),
      body: text.slice(bodyMatch.index + bodyMatch[0].length).trim(),
    }
  }

  const [first, ...rest] = text.split('\n')
  return { title: (first ?? '').replace(/^#+\s*/, '').trim(), body: rest.join('\n').trim() }
}

export async function generatePrSummary(
  repoPath: string,
  baseBranch: string,
  signal?: AbortSignal,
): Promise<PrSummary> {
  const config = getCommitMessageConfig()
  const providerId = config.providerId || 'claude'
  const modelId = config.modelId || undefined

  const context = await buildPrContext(repoPath, baseBranch)
  if (context.length === 0) {
    throw new Error('No changes to summarize')
  }

  const prompt = `Write a pull request title and description for the changes below.\n\nRules:\n- ${RULES}\n\n${context}`

  const summary = parseSummary(await runOneShotPrompt({ prompt, cwd: repoPath, providerId, modelId, signal }))
  if (!summary.title) throw new Error('Model returned an empty PR title')
  return summary
}
