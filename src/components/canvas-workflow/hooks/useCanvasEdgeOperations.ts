import { useCallback, type MutableRefObject } from "react"
import {
  addEdge,
  type Connection,
  type EdgeChange,
} from "@xyflow/react"
import type { CanvasEdge } from "@/components/canvas-workflow/utils/canvasConversions"

interface UseCanvasEdgeOperationsParams {
  edgesRef: MutableRefObject<CanvasEdge[]>
  setEdges: React.Dispatch<React.SetStateAction<CanvasEdge[]>>
  rawOnEdgesChange: (changes: EdgeChange<CanvasEdge>[]) => void
  setDirty: (dirty: boolean) => void
}

export function useCanvasEdgeOperations({
  edgesRef,
  setEdges,
  rawOnEdgesChange,
  setDirty,
}: UseCanvasEdgeOperationsParams) {
  // Wrap onEdgesChange to prevent deletion of session edges
  const onEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    // Filter out any attempts to remove session edges (marked with data.isSessionEdge)
    const filteredChanges = changes.filter((change) => {
      if (change.type === "remove") {
        const edge = edgesRef.current.find((e) => e.id === change.id)
        if (edge?.data?.isSessionEdge) {
          return false // Prevent deletion of session edges
        }
      }
      return true
    })
    if (filteredChanges.length > 0) {
      const hasStructuralChange = filteredChanges.some(
        (c) => c.type === "add" || c.type === "remove"
      )
      if (hasStructuralChange) setDirty(true)
    }
    rawOnEdgesChange(filteredChanges)
  }, [rawOnEdgesChange, edgesRef, setDirty])

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge({ ...connection, id: `e-${connection.source}-${connection.target}` }, eds))
      setDirty(true)
    },
    [setEdges, setDirty]
  )

  return {
    onEdgesChange,
    onConnect,
  }
}
