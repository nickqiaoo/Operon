import { useCallback, type MutableRefObject } from "react"
import type {
  NodeChange,
  NodeRemoveChange,
  ReactFlowInstance,
  XYPosition,
} from "@xyflow/react"
import dagre from "@dagrejs/dagre"
import type { CanvasAISessionNodeData } from "@/types/canvas-workflow"
import {
  findRootAINodeInfo,
  fromReactFlowNodes,
  type CanvasNode,
  type CanvasEdge,
} from "@/components/canvas-workflow/utils/canvasConversions"

interface UseCanvasNodeOperationsParams {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  nodesRef: MutableRefObject<CanvasNode[]>
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>
  setEdges: React.Dispatch<React.SetStateAction<CanvasEdge[]>>
  rawOnNodesChange: (changes: NodeChange<CanvasNode>[]) => void
  setDirty: (dirty: boolean) => void
  initialLoadRef: MutableRefObject<boolean>
  reactFlowInstanceRef: MutableRefObject<ReactFlowInstance | null>
}

export function useCanvasNodeOperations({
  nodes,
  edges,
  nodesRef,
  setNodes,
  setEdges,
  rawOnNodesChange,
  setDirty,
  initialLoadRef,
  reactFlowInstanceRef,
}: UseCanvasNodeOperationsParams) {
  // Wrap onNodesChange to cascade-delete session descendants and track dirty
  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    const hasStructuralChange = changes.some(
      (c) => c.type === "add" || c.type === "remove" || c.type === "position"
    )
    if (hasStructuralChange && !initialLoadRef.current) setDirty(true)
    const removeChanges = changes.filter((c): c is NodeRemoveChange => c.type === "remove")

    if (removeChanges.length > 0) {
      const removingIds = new Set(removeChanges.map(c => c.id))
      const currentNodes = nodesRef.current

      // Walk chains: any session node whose parentNodeId is being removed gets removed too
      let changed = true
      while (changed) {
        changed = false
        for (const n of currentNodes) {
          if (n.type === "aiSessionNode" && !removingIds.has(n.id)) {
            const sessionData = n.data.nodeData as CanvasAISessionNodeData | undefined
            if (sessionData && removingIds.has(sessionData.parentNodeId)) {
              removingIds.add(n.id)
              changed = true
            }
          }
        }
      }

      // Inject extra remove changes for cascade-deleted descendants
      const existingRemoveIds = new Set(removeChanges.map(c => c.id))
      const extraChanges: NodeRemoveChange[] = []
      for (const id of removingIds) {
        if (!existingRemoveIds.has(id)) {
          extraChanges.push({ type: "remove", id })
        }
      }
      if (extraChanges.length > 0) {
        changes = [...changes, ...extraChanges]
      }

      // Remove edges connected to removed nodes (including session edges)
      setEdges((eds) => eds.filter((e) => !removingIds.has(e.source) && !removingIds.has(e.target)))
    }

    rawOnNodesChange(changes)
  }, [rawOnNodesChange, setEdges, nodesRef, initialLoadRef, setDirty])

  // Add node
  const addNode = useCallback((type: "input" | "ai") => {
    const id = `node-${Date.now()}`

    // Place node at the center of the current viewport
    let position = { x: 100 + nodes.length * 300, y: 200 }
    const instance = reactFlowInstanceRef.current
    if (instance) {
      const viewport = instance.getViewport()
      const flowEl = document.querySelector('.react-flow') as HTMLElement | null
      if (flowEl) {
        const { width, height } = flowEl.getBoundingClientRect()
        position = {
          x: (-viewport.x + width / 2) / viewport.zoom - 100,
          y: (-viewport.y + height / 2) / viewport.zoom - 50,
        }
      }
    }

    const newNode: CanvasNode = {
      id,
      type: type === "input" ? "inputNode" : "aiNode",
      position,
      data: {
        name: type === "input" ? "Input" : "AI Node",
        nodeData: type === "input"
          ? { prompt: "" }
          : { providerId: "claude-code", userPrompt: "" },
      },
    }

    setNodes((nds) => [...nds, newNode])
    setDirty(true)
  }, [nodes.length, setNodes, setDirty, reactFlowInstanceRef])

  // Check if a node already has a session child
  const hasSessionChild = useCallback((nodeId: string) => {
    return nodes.some(n => {
      if (n.type !== "aiSessionNode") return false
      const sessionData = n.data.nodeData as CanvasAISessionNodeData | undefined
      return sessionData?.parentNodeId === nodeId
    })
  }, [nodes])

  // Add session node (right-click "Continue Session")
  const addSessionNode = useCallback((parentNodeId: string) => {
    const parentNode = nodes.find(n => n.id === parentNodeId)
    if (!parentNode) return

    // Each node can only have one session child
    if (hasSessionChild(parentNodeId)) return

    const id = `node-${Date.now()}`
    const parentName = (parentNode.data.name as string) || parentNodeId

    // Resolve root AI node info for display
    const backendNodes = fromReactFlowNodes(nodes)
    const rootInfo = findRootAINodeInfo(parentNodeId, backendNodes)

    const newNode: CanvasNode = {
      id,
      type: "aiSessionNode",
      position: {
        x: parentNode.position.x + 280,
        y: parentNode.position.y,
      },
      data: {
        name: `${parentName}-Session`,
        nodeData: {
          parentNodeId,
          prompt: "",
        } satisfies CanvasAISessionNodeData,
        parentName,
        parentProviderId: rootInfo?.providerId || "",
      },
    }

    // Create a session edge (dashed line, non-deletable)
    const sessionEdge: CanvasEdge = {
      id: `session-edge-${parentNodeId}-${id}`,
      source: parentNodeId,
      target: id,
      style: {
        strokeDasharray: '8 4',
        strokeWidth: 2.5,
        stroke: '#6366f1',
        opacity: 0.6,
      },
      data: { isSessionEdge: true },
      type: 'default',
    }

    setNodes((nds) => [...nds, newNode])
    setEdges((eds) => [...eds, sessionEdge])
    setDirty(true)
  }, [nodes, setNodes, setEdges, setDirty, hasSessionChild])

  // Update node data
  const updateNodeData = useCallback((nodeId: string, updates: Record<string, unknown>) => {
    setNodes((nds) => {
      const updatedNodes = nds.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, ...updates } }
          : n
      )

      // If an AI node's name changed, update parentName on its direct session children
      if (updates.name !== undefined) {
        return updatedNodes.map(n => {
          if (n.type !== "aiSessionNode") return n
          const sessionData = n.data.nodeData as CanvasAISessionNodeData | undefined
          if (sessionData?.parentNodeId === nodeId) {
            return { ...n, data: { ...n.data, parentName: updates.name as string } }
          }
          return n
        })
      }

      return updatedNodes
    })
    setDirty(true)
  }, [setNodes, setDirty])

  // Delete specific nodes by ID
  const deleteNodes = useCallback((nodeIds: string[]) => {
    const idsToRemove = new Set(nodeIds)

    // Cascade: remove session children of removed nodes
    const currentNodes = nodesRef.current
    let changed = true
    while (changed) {
      changed = false
      for (const n of currentNodes) {
        if (n.type === "aiSessionNode" && !idsToRemove.has(n.id)) {
          const sessionData = n.data.nodeData as CanvasAISessionNodeData | undefined
          if (sessionData && idsToRemove.has(sessionData.parentNodeId)) {
            idsToRemove.add(n.id)
            changed = true
          }
        }
      }
    }

    setNodes((nds) => nds.filter((n) => !idsToRemove.has(n.id)))
    setEdges((eds) => eds.filter((e) => !idsToRemove.has(e.source) && !idsToRemove.has(e.target)))
    setDirty(true)
  }, [setNodes, setEdges, setDirty, nodesRef])

  // Duplicate nodes with offset
  const duplicateNodes = useCallback((nodeIds: string[]) => {
    const currentNodes = nodesRef.current
    const toDuplicate = currentNodes.filter((n) => nodeIds.includes(n.id))
    if (toDuplicate.length === 0) return

    const idMap = new Map<string, string>()
    const newNodes: CanvasNode[] = toDuplicate.map((n) => {
      const newId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      idMap.set(n.id, newId)
      return {
        ...n,
        id: newId,
        position: { x: n.position.x + 50, y: n.position.y + 50 },
        selected: false,
        data: { ...n.data },
      }
    })

    setNodes((nds) => [...nds, ...newNodes])

    // Duplicate edges between duplicated nodes
    const currentEdges = edges
    const newEdges: CanvasEdge[] = []
    for (const e of currentEdges) {
      const newSource = idMap.get(e.source)
      const newTarget = idMap.get(e.target)
      if (newSource && newTarget) {
        newEdges.push({
          ...e,
          id: `e-${newSource}-${newTarget}`,
          source: newSource,
          target: newTarget,
        })
      }
    }
    if (newEdges.length > 0) {
      setEdges((eds) => [...eds, ...newEdges])
    }
    setDirty(true)
  }, [edges, setNodes, setEdges, setDirty, nodesRef])

  // Add node at specific position (for pane context menu)
  const addNodeAtPosition = useCallback((type: "input" | "ai", position: XYPosition) => {
    const id = `node-${Date.now()}`
    const newNode: CanvasNode = {
      id,
      type: type === "input" ? "inputNode" : "aiNode",
      position,
      data: {
        name: type === "input" ? "Input" : "AI Node",
        nodeData: type === "input"
          ? { prompt: "" }
          : { providerId: "claude-code", userPrompt: "" },
      },
    }
    setNodes((nds) => [...nds, newNode])
    setDirty(true)
  }, [setNodes, setDirty])

  // Auto-layout using dagre
  const autoLayout = useCallback(() => {
    const currentNodes = nodesRef.current
    const currentEdges = edges
    if (currentNodes.length === 0) return

    const g = new dagre.graphlib.Graph()
    g.setDefaultEdgeLabel(() => ({}))
    g.setGraph({ rankdir: "LR", nodesep: 80, ranksep: 200 })

    const nodeWidth = 220
    const nodeHeight = 100

    for (const node of currentNodes) {
      g.setNode(node.id, { width: nodeWidth, height: nodeHeight })
    }
    for (const edge of currentEdges) {
      g.setEdge(edge.source, edge.target)
    }

    dagre.layout(g)

    setNodes((nds) =>
      nds.map((node) => {
        const pos = g.node(node.id)
        if (!pos) return node
        return {
          ...node,
          position: {
            x: pos.x - nodeWidth / 2,
            y: pos.y - nodeHeight / 2,
          },
        }
      })
    )

    // Fit view after layout
    setTimeout(() => {
      reactFlowInstanceRef.current?.fitView({ padding: 0.2, duration: 300 })
    }, 50)
  }, [edges, setNodes, nodesRef, reactFlowInstanceRef])

  // Update node status for execution visualization
  const updateNodeStatuses = useCallback((statusMap: Record<string, string>, extraData?: Record<string, unknown>) => {
    setNodes((nds) => {
      let changed = false

      const nextNodes = nds.map((n) => {
        const nextStatus = statusMap[n.id]
        const currentStatus = (n.data as Record<string, unknown>).status

        let nodeChanged = currentStatus !== nextStatus
        const mergedData: Record<string, unknown> = { ...n.data, status: nextStatus }

        if (extraData) {
          for (const [key, value] of Object.entries(extraData)) {
            if ((n.data as Record<string, unknown>)[key] !== value) {
              nodeChanged = true
            }
            mergedData[key] = value
          }
        }

        if (!nodeChanged) return n
        changed = true
        return { ...n, data: mergedData }
      })

      return changed ? nextNodes : nds
    })
  }, [setNodes])

  return {
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
  }
}
