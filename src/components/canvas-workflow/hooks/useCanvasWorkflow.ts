import { useCallback, useRef, useState } from "react"
import {
  useNodesState,
  useEdgesState,
  type ReactFlowInstance,
} from "@xyflow/react"
import type { CanvasNode, CanvasEdge } from "@/components/canvas-workflow/utils/canvasConversions"
import { useCanvasNodeOperations } from "./useCanvasNodeOperations"
import { useCanvasEdgeOperations } from "./useCanvasEdgeOperations"
import { useCanvasAutoSave } from "./useCanvasAutoSave"

export function useCanvasWorkflow(workflowId?: number) {
  const [nodes, setNodes, rawOnNodesChange] = useNodesState<CanvasNode>([])
  const [edges, setEdges, rawOnEdgesChange] = useEdgesState<CanvasEdge>([])
  const [dirty, setDirty] = useState(false)
  const reactFlowInstanceRef = useRef<ReactFlowInstance | null>(null)
  const initialLoadRef = useRef(true)

  const setReactFlowInstance = useCallback((instance: ReactFlowInstance) => {
    reactFlowInstanceRef.current = instance
  }, [])

  // Keep refs to current nodes/edges for use in callbacks
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  const edgesRef = useRef(edges)
  edgesRef.current = edges

  // Auto-save and workflow loading
  const {
    workflow,
    setWorkflow,
    saving,
    lastSavedAt,
    saveError,
    save,
  } = useCanvasAutoSave({
    workflowId,
    nodes,
    edges,
    setNodes,
    setEdges,
    dirty,
    setDirty,
    initialLoadRef,
  })

  // Edge operations
  const {
    onEdgesChange,
    onConnect,
  } = useCanvasEdgeOperations({
    edgesRef,
    setEdges,
    rawOnEdgesChange,
    setDirty,
  })

  // Node operations
  const {
    onNodesChange,
    addNode,
    addNodeAtPosition,
    addSessionNode,
    hasSessionChild,
    deleteNodes,
    duplicateNodes,
    autoLayout,
    updateNodeData,
    updateNodeStatuses,
  } = useCanvasNodeOperations({
    nodes,
    edges,
    nodesRef,
    setNodes,
    setEdges,
    rawOnNodesChange,
    setDirty,
    initialLoadRef,
    reactFlowInstanceRef,
  })

  return {
    workflow,
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    save,
    saving,
    dirty,
    lastSavedAt,
    saveError,
    addNode,
    addNodeAtPosition,
    addSessionNode,
    hasSessionChild,
    deleteNodes,
    duplicateNodes,
    autoLayout,
    updateNodeData,
    updateNodeStatuses,
    setWorkflow,
    setReactFlowInstance,
  }
}
