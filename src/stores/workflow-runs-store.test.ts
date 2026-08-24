import { beforeEach, describe, expect, it } from "vitest"
import type { WorkflowRunView } from "@/lib/api"
import { useWorkflowRunsStore } from "./workflow-runs-store"

function run(runId: string, status: WorkflowRunView["status"] = "running"): WorkflowRunView {
  return {
    runId,
    taskId: `task-${runId}`,
    name: "nightly",
    description: "",
    status,
    phases: [],
    agents: [],
    failures: [],
    startedAt: 1,
    hasResult: false,
  }
}

describe("workflow runs store", () => {
  beforeEach(() => {
    useWorkflowRunsStore.setState({ runs: [], startSignals: new Set(), streams: new Map() })
  })

  describe("start signals", () => {
    // The regression this file exists for: the feed opens with a backlog of
    // recent runs, and the workflow panel used to read that as "runs started"
    // and raise itself on every launch.
    it("does not treat a sync snapshot as runs starting", () => {
      useWorkflowRunsStore.getState().setRuns([run("a", "completed"), run("b", "failed")])

      expect(useWorkflowRunsStore.getState().runs).toHaveLength(2)
      expect(useWorkflowRunsStore.getState().startSignals.size).toBe(0)
    })

    it("records a run the node reports as started", () => {
      useWorkflowRunsStore.getState().noteRunStarted("a", 7)

      expect([...useWorkflowRunsStore.getState().startSignals]).toEqual(["7:a"])
    })

    it("ignores a repeat of the same event", () => {
      const store = useWorkflowRunsStore.getState()
      store.noteRunStarted("a", 7)
      const afterFirst = useWorkflowRunsStore.getState().startSignals

      store.noteRunStarted("a", 7)

      // Same Set instance, so a subscriber does not re-render — a redelivered
      // frame (reconnect replays from a cursor) must not reopen the panel.
      expect(useWorkflowRunsStore.getState().startSignals).toBe(afterFirst)
    })

    it("signals again when a run is resumed under its original id", () => {
      const store = useWorkflowRunsStore.getState()
      store.noteRunStarted("a", 7)
      store.noteRunStarted("a", 12)

      expect([...useWorkflowRunsStore.getState().startSignals]).toEqual(["7:a", "12:a"])
    })
  })

  describe("run list", () => {
    it("sorts newest first and replaces on sync", () => {
      const store = useWorkflowRunsStore.getState()
      store.setRuns([{ ...run("old"), startedAt: 10 }, { ...run("new"), startedAt: 20 }])

      expect(useWorkflowRunsStore.getState().runs.map((r) => r.runId)).toEqual(["new", "old"])
    })

    it("upserts a run in place without duplicating it", () => {
      const store = useWorkflowRunsStore.getState()
      store.setRuns([run("a")])
      store.upsertRun({ ...run("a", "completed"), endedAt: 5 })

      const runs = useWorkflowRunsStore.getState().runs
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe("completed")
    })
  })
})
