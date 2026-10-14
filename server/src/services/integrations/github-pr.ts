import * as gitService from '../git.js'
import { parseGithubRemote } from './github.js'

/** Carries the HTTP status a failed precondition should map to. */
export class PrRequestError extends Error {
  constructor(readonly status: 400 | 500, message: string) {
    super(message)
  }
}

/**
 * Get the branch into a state GitHub can open a PR from: make sure we are on a
 * branch that is not the base, optionally commit the working tree, and push.
 * Shared by "create the PR here" and "open the PR in the browser".
 */
export async function prepareBranchForPr(
  repoPath: string,
  opts: {
    branchName: string
    baseBranch: string
    commitMessage?: string
    commitLocalChanges?: boolean
    remote?: string
  },
): Promise<{ owner: string; repo: string; remoteName: string }> {
  const remotes = await gitService.listRemotes(repoPath)
  const remote = remotes.find((r) => r.name === (opts.remote ?? 'origin')) ?? remotes[0]
  if (!remote) throw new PrRequestError(400, 'No git remote configured')
  const parsed = parseGithubRemote(remote.url)
  if (!parsed) throw new PrRequestError(400, `Remote ${remote.url} is not a GitHub repo`)

  const currentBranch = await gitService.getCurrentBranch(repoPath)
  if (currentBranch === opts.baseBranch || opts.branchName !== currentBranch) {
    if (await gitService.localBranchExists(repoPath, opts.branchName)) {
      throw new PrRequestError(
        400,
        `Branch ${opts.branchName} already exists locally. Pick a different name.`,
      )
    }
    await gitService.checkoutNewBranch(repoPath, opts.branchName)
  }

  if (opts.commitLocalChanges !== false) {
    const status = await gitService.getStatus(repoPath)
    const hasChanges =
      status.staged.length + status.unstaged.length + status.untracked.length > 0
    if (hasChanges) {
      if (!opts.commitMessage) {
        throw new PrRequestError(400, 'commitMessage is required for uncommitted changes')
      }
      await gitService.stageAll(repoPath)
      await gitService.commit(repoPath, opts.commitMessage)
    }
  }

  await gitService.pushBranch(repoPath, remote.name, opts.branchName, true)
  return { owner: parsed.owner, repo: parsed.repo, remoteName: remote.name }
}
