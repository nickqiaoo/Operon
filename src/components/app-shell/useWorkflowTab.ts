import { useEffect, useRef } from "react"
import { useIntl } from "react-intl"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useTabsStore } from "@/stores/tabs-store"
import { useWorkflowRunsStore } from "@/stores/workflow-runs-store"

/** One tab holds every run, so its id is fixed. */
const WORKFLOW_TAB_ID = "workflow"

/**
 * Open (and focus) the workflow panel — what the "open panel" button on a
 * workflow tool call calls.
 *
 * Unlike the automatic open below this one DOES activate the tab: the user just
 * asked for it. Exported as a plain function so a message-list card can reach the
 * panel without threading tab plumbing through the renderer tree.
 */
export function openWorkflowPanel(title = "Workflow"): void {
  useTabsStore.getState().openTab(
    "right",
    { tabId: WORKFLOW_TAB_ID, title, isClosable: true, payload: { type: "workflow" } },
    { activate: true },
  )
  // The tab and the panel are two different pieces of state: `openTab` only puts
  // the tab in the right panel's list, it does not reveal a collapsed panel. With
  // the panel closed — its default — the button looked dead.
  useAppShellStore.getState().setRightPanelOpen(true)
}

/**
 * Opens the workflow tab when a run starts, and keeps its title current.
 *
 * A workflow is not a tool the user reaches for — it starts because a model
 * decided to run one. So it appears on its own, and once the user closes it, it
 * stays closed for the runs it was showing; only a NEW run brings it back, which
 * is why the signals already acted on are tracked rather than just "are there
 * runs". (A closed panel is still reachable on demand — every workflow tool call
 * in the transcript carries a button that calls `openWorkflowPanel`.)
 *
 * It reacts to `startSignals`, never to the run LIST. Those differ on every
 * launch: the feed opens with a backlog of recent runs, and reading that as
 * "runs appeared, so runs started" raised this tab on boot for work that had
 * finished days earlier — with nothing else in the right panel, opening it then
 * always landed on the workflow tab. Whether a run is beginning is the node's
 * fact to state, and it states it.
 *
 * It never steals focus (`activate: false`). The run is happening in the
 * background; if it needs the user, a blocked sub-agent surfaces above the
 * composer and in the approval inbox instead.
 */
export function useWorkflowTab(): void {
  const intl = useIntl()
  const runs = useWorkflowRunsStore((s) => s.runs)
  const startSignals = useWorkflowRunsStore((s) => s.startSignals)
  const openTab = useTabsStore((s) => s.openTab)
  const updateTab = useTabsStore((s) => s.updateTab)
  const rightTabs = useTabsStore((s) => s.right.tabs)

  /** Signals already offered a tab — a closed tab must not reopen for these. */
  const announced = useRef(new Set<string>())

  const runningCount = runs.filter((run) => run.status === "running").length
  const title =
    runningCount > 1
      ? intl.formatMessage(
          { id: "workflow.tab.titleCount", defaultMessage: "Workflows ({count})" },
          { count: runningCount },
        )
      : intl.formatMessage({ id: "workflow.tab.title", defaultMessage: "Workflow" })

  useEffect(() => {
    let started = false
    for (const signal of startSignals) {
      if (announced.current.has(signal)) continue
      announced.current.add(signal)
      started = true
    }
    if (!started) return

    openTab(
      "right",
      {
        tabId: WORKFLOW_TAB_ID,
        title,
        isClosable: true,
        payload: { type: "workflow" },
      },
      { activate: false },
    )
    // `title` is deliberately not a dependency: it changes as agents finish, and
    // reopening the tab on every count change would undo the user closing it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSignals, openTab])

  // Keep the title in step with the run count, but only while the tab exists —
  // updateTab on a closed tab would be a no-op anyway, this just makes it explicit.
  const tabOpen = rightTabs.some((t) => t.tabId === WORKFLOW_TAB_ID)
  useEffect(() => {
    if (!tabOpen) return
    updateTab("right", WORKFLOW_TAB_ID, { title })
  }, [tabOpen, title, updateTab])
}
