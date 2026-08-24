import { useCallback, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { trackEvent } from "@/lib/analytics"
import type { PushErrorCode } from "@/lib/api-client"
import { gitKeys } from "@/lib/git-queries"

export type GitWorkflowStep = "commit" | "push"

export interface GitWorkflowParams {
  steps: GitWorkflowStep[]
  commit?: { message: string; includeUnstaged: boolean }
  push?: { setUpstream: boolean; force: boolean }
  /** Current branch name, for toast copy. */
  branch?: string | null
}

const PUSH_ERROR_COPY: Record<PushErrorCode, string> = {
  "no-remote": "No git remote configured for push.",
  "no-upstream": "No upstream branch set for the current branch.",
  rejected: "Push rejected — the remote has commits you don't have. Pull first or force push.",
  "remote-changed": "Remote changed since you last fetched. Fetch first or force push.",
  auth: "Authentication failed. Check your git credentials.",
  unknown: "Failed to push changes.",
}

/**
 * Runs a Codex-style git workflow: a sequence of steps (`commit`, `push`, or
 * both for "Commit & push") executed in order. Refreshes the Review diff and
 * surfaces step-specific toasts; stops at the first failing step.
 */
export function useGitWorkflow(rootPath: string) {
  const queryClient = useQueryClient()
  const [running, setRunning] = useState(false)

  const run = useCallback(
    async (params: GitWorkflowParams): Promise<boolean> => {
      setRunning(true)
      try {
        for (const step of params.steps) {
          if (step === "commit") {
            if (!params.commit) throw new Error("Missing commit parameters")
            await api.gitCommit(rootPath, params.commit.message, params.commit.includeUnstaged)
            // The strongest "the work was good" signal the app has: everything
            // else only records that the user opened or sent something.
            trackEvent("changes_committed", {
              pushed: params.steps.includes("push"),
              include_unstaged: params.commit.includeUnstaged,
            })
            toast.success(params.branch ? `Committed to ${params.branch}` : "Committed changes")
          } else if (step === "push") {
            const result = await api.gitPush(rootPath, {
              setUpstream: params.push?.setUpstream,
              force: params.push?.force,
            })
            if (!result.success) {
              const code = (result.code ?? "unknown") as PushErrorCode
              toast.error(PUSH_ERROR_COPY[code] ?? PUSH_ERROR_COPY.unknown)
              return false
            }
            toast.success(params.branch ? `Pushed ${params.branch}` : "Pushed changes")
          }
        }
        return true
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Git action failed")
        return false
      } finally {
        await queryClient.invalidateQueries({ queryKey: gitKeys.all(rootPath) })
        setRunning(false)
      }
    },
    [queryClient, rootPath]
  )

  return { run, running }
}
