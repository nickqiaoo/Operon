import { useCallback, useRef, useState } from "react"
import { useIntl } from "react-intl"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { gitKeys } from "@/lib/git-queries"
import { openExternalUrl } from "@/lib/open-external"

export type PrAction = "pr" | "draft" | "browser"

/**
 * `summary` is the only cancellable phase — once git starts pushing, stopping
 * would leave the remote in a state the UI just claimed it abandoned.
 */
export type PrPhase = "summary" | "publishing"

export interface ExistingPr {
  number: number
  url: string
  title: string
  isDraft: boolean
}

export interface StartPrInput {
  action: PrAction
  branch: string
  base: string
  title: string
  body: string
  commitLocalChanges: boolean
}

/**
 * Runs the create-PR sequence outside the dialog, so the dialog can close the
 * moment the user picks an action and the toolbar carries the progress (and the
 * Stop affordance) the way Codex does.
 */
export function usePrCreation(rootPath: string) {
  const intl = useIntl()
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<PrPhase | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const start = useCallback(
    async (input: StartPrInput) => {
      if (abortRef.current) return
      const controller = new AbortController()
      abortRef.current = controller
      // Mirrors `phase` for the catch block: setState is async, so the state
      // value here would still read null when an early failure lands.
      let current: PrPhase | null = null

      try {
        let title = input.title.trim()
        let body = input.body.trim()

        // GitHub's compare form has its own title/body fields, so spending a
        // model call before handing off there would be wasted.
        if (input.action !== "browser" && (title.length === 0 || body.length === 0)) {
          current = "summary"
          setPhase("summary")
          const summary = await api.gitGeneratePrSummary(rootPath, input.base, controller.signal)
          if (title.length === 0) title = summary.title
          if (body.length === 0) body = summary.body
        }

        current = "publishing"
        setPhase("publishing")
        const shared = {
          repoPath: rootPath,
          branchName: input.branch,
          baseBranch: input.base,
          commitLocalChanges: input.commitLocalChanges,
          commitMessage: title || undefined,
        }

        if (input.action === "browser") {
          const { compareUrl } = await api.integrationGithubPushForPR(shared)
          openExternalUrl(compareUrl)
          return
        }

        const res = await api.integrationGithubCreatePR({
          ...shared,
          title,
          body,
          draft: input.action === "draft",
        })
        toast.success(
          intl.formatMessage({ id: "pr.created", defaultMessage: "PR #{number} created" }, { number: res.pr.number }),
          {
            action: {
              label: intl.formatMessage({ id: "common.open", defaultMessage: "Open" }),
              onClick: () => openExternalUrl(res.pr.url),
            },
          },
        )
      } catch (error) {
        // A Stop is the user's own doing — nothing to report back to them.
        if (controller.signal.aborted) return
        const fallback =
          current === "summary"
            ? intl.formatMessage({
                id: "pr.error.generate",
                defaultMessage: "Failed to generate the PR summary",
              })
            : intl.formatMessage({ id: "pr.error.create", defaultMessage: "Failed to create PR" })
        toast.error(error instanceof Error ? error.message : fallback)
      } finally {
        abortRef.current = null
        setPhase(null)
        await queryClient.invalidateQueries({ queryKey: gitKeys.all(rootPath) })
      }
    },
    [intl, queryClient, rootPath],
  )

  return { phase, running: phase != null, start, cancel }
}
