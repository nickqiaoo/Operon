import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"
import type { CanvasWorkflowRun } from "@/types/canvas-workflow"
import {
  invalidateCanvasWorkflowRuns,
  isTerminalRun,
  useCanvasWorkflowRun,
  useCanvasWorkflowRuns,
} from "@/lib/canvas-workflow-queries"

const NO_RUNS: CanvasWorkflowRun[] = []

export function useCanvasExecution(workflowId?: number) {
  const [runId, setRunId] = useState<number | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [starting, setStarting] = useState(false)

  // History is keyed by workflow, so switching workflows never shows the
  // previous one's runs while the new list loads.
  const runsQuery = useCanvasWorkflowRuns(workflowId)
  const runs = workflowId ? runsQuery.data ?? NO_RUNS : NO_RUNS

  // The run just started, polled until it finishes (see useCanvasWorkflowRun).
  const runQuery = useCanvasWorkflowRun(runId)
  const run = runId != null ? runQuery.data ?? null : null
  const finished = isTerminalRun(runQuery.data)
  const executing = starting || (runId != null && !finished && !runQuery.isError)

  // Refresh run history once the live run lands.
  useEffect(() => {
    if (finished && workflowId) void invalidateCanvasWorkflowRuns(workflowId)
  }, [finished, workflowId])

  const execute = useCallback(async () => {
    if (!workflowId) return
    setStarting(true)
    try {
      const result = await api.canvasWorkflowExecute(workflowId)
      setRunId(result.runId)
      setSelectedRunId(result.runId)
    } catch (err) {
      console.error("[CanvasExecution] Failed to start:", err)
    } finally {
      setStarting(false)
    }
  }, [workflowId])

  // The currently viewed run: either the live run or a selected historical one
  const selectedRun = useMemo(() => {
    if (!selectedRunId) return null
    if (selectedRunId === runId) return run
    return runs.find((r) => r.id === selectedRunId) ?? null
  }, [selectedRunId, runId, run, runs])

  const selectRun = useCallback((id: number) => {
    setSelectedRunId((prev) => (prev === id ? null : id))
  }, [])

  const nodeStatusMap = useMemo(() => {
    if (!selectedRun) return {}
    return Object.fromEntries(selectedRun.nodeResults.map((r) => [r.nodeId, r.status]))
  }, [selectedRun])

  /** Progress text group nodes publish while running ("2/5 done"). */
  const nodeProgressMap = useMemo(() => {
    if (!selectedRun) return {}
    return Object.fromEntries(
      selectedRun.nodeResults
        .filter((r) => r.status === "running" && r.output)
        .map((r) => [r.nodeId, r.output as string])
    )
  }, [selectedRun])

  const reset = useCallback(() => {
    setRunId(null)
    setStarting(false)
  }, [])

  return { execute, run, selectedRun, runs, selectRun, selectedRunId, nodeStatusMap, nodeProgressMap, executing, reset }
}
