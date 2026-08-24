import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "@/lib/api"
import type { CanvasWorkflowRun } from "@/types/canvas-workflow"

export function useCanvasExecution(workflowId?: number) {
  const [runId, setRunId] = useState<number | null>(null)
  const [run, setRun] = useState<CanvasWorkflowRun | null>(null)
  const [runs, setRuns] = useState<CanvasWorkflowRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [executing, setExecuting] = useState(false)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
  }, [])

  // Fetch run history
  const fetchRuns = useCallback(async () => {
    if (!workflowId) return
    try {
      const { runs: runList } = await api.canvasWorkflowListRuns(workflowId, 20)
      setRuns(runList)
    } catch {
      // ignore
    }
  }, [workflowId])

  // Load history on workflow change
  useEffect(() => {
    if (workflowId) {
      fetchRuns()
    } else {
      setRuns([])
    }
  }, [workflowId, fetchRuns])

  const execute = useCallback(async () => {
    if (!workflowId) return
    setExecuting(true)
    try {
      const result = await api.canvasWorkflowExecute(workflowId)
      setRunId(result.runId)
      setSelectedRunId(result.runId)
    } catch (err) {
      console.error("[CanvasExecution] Failed to start:", err)
      setExecuting(false)
    }
  }, [workflowId])

  // Poll execution status
  useEffect(() => {
    if (!runId) return

    const poll = async () => {
      try {
        const { run: runData } = await api.canvasWorkflowGetRun(runId)
        setRun(runData)
        if (runData.status === "success" || runData.status === "error") {
          stopPolling()
          setExecuting(false)
          // Refresh run history after completion
          fetchRuns()
        }
      } catch {
        stopPolling()
        setExecuting(false)
      }
    }

    // Immediate first poll
    void poll()

    pollingRef.current = setInterval(poll, 2000)
    return () => stopPolling()
  }, [runId, stopPolling, fetchRuns])

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

  const reset = useCallback(() => {
    stopPolling()
    setRunId(null)
    setRun(null)
    setExecuting(false)
  }, [stopPolling])

  return { execute, run, selectedRun, runs, selectRun, selectedRunId, nodeStatusMap, executing, reset }
}
