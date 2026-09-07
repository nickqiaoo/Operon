import { useCallback, type MutableRefObject } from "react"
import { DEFAULT_GROUP_SIZE, NODE_TYPES, isGroupReactFlowType, type CreatableNodeType } from "../node-registry"
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
        || (c.type === "dimensions" && c.resizing === false)
    )
    if (hasStructuralChange && !initialLoadRef.current) setDirty(true)
    const removeChanges = changes.filter((c): c is NodeRemoveChange => c.type === "remove")

    if (removeChanges.length > 0) {
      const removingIds = new Set(removeChanges.map(c => c.id))
      const currentNodes = nodesRef.current

      // Walk chains: session continuations and group members of removed nodes go too
      let changed = true
      while (changed) {
        changed = false
        for (const n of currentNodes) {
          if (n.parentId && removingIds.has(n.parentId) && !removingIds.has(n.id)) {
            removingIds.add(n.id)
            changed = true
          }
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
  const addNode = useCallback((type: CreatableNodeType) => {
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
      type: NODE_TYPES[type].rfType,
      position,
      data: NODE_TYPES[type].create!(),
      ...(NODE_TYPES[type].group ? { style: { ...DEFAULT_GROUP_SIZE }, ...DEFAULT_GROUP_SIZE } : {}),
    }

    setNodes((nds) => (NODE_TYPES[type].group ? [newNode, ...nds] : [...nds, newNode]))
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

  /**
   * Dropping a node inside a group adopts it (position becomes relative);
   * dragging it out releases it. Edges that would now cross the border are
   * dropped, since the engine has no meaning for them.
   */
  const onNodeDragStop = useCallback((_event: unknown, dragged: CanvasNode) => {
    if (isGroupReactFlowType(dragged.type)) return
    const currentNodes = nodesRef.current
    const byId = new Map(currentNodes.map((n) => [n.id, n]))

    const absoluteOf = (node: CanvasNode): XYPosition => {
      const parent = node.parentId ? byId.get(node.parentId) : undefined
      return parent
        ? { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y }
        : node.position
    }
    const abs = absoluteOf(dragged)
    const center = { x: abs.x + (dragged.width ?? 220) / 2, y: abs.y + (dragged.height ?? 80) / 2 }

    const target = currentNodes.find((n) => {
      if (!isGroupReactFlowType(n.type) || n.id === dragged.id) return false
      const w = n.width ?? DEFAULT_GROUP_SIZE.width
      const h = n.height ?? DEFAULT_GROUP_SIZE.height
      return center.x >= n.position.x && center.x <= n.position.x + w
        && center.y >= n.position.y && center.y <= n.position.y + h
    })

    const nextParentId = target?.id
    if (nextParentId === dragged.parentId) return

    setNodes((nds) => {
      const updated = nds.map((n) => {
        if (n.id !== dragged.id) return n
        if (target) {
          const { extent: _extent, ...rest } = n
          void _extent
          return {
            ...rest,
            parentId: target.id,
            extent: "parent" as const,
            position: { x: Math.max(0, abs.x - target.position.x), y: Math.max(40, abs.y - target.position.y) },
          }
        }
        const { parentId: _parentId, extent: _extent, ...rest } = n
        void _parentId; void _extent
        return { ...rest, position: abs }
      })
      // Parents must precede children in the array.
      return [...updated.filter((n) => !n.parentId), ...updated.filter((n) => n.parentId)]
    })
    setEdges((eds) => eds.filter((e) => {
      const source = e.source === dragged.id ? { parentId: nextParentId } : byId.get(e.source)
      const targetNode = e.target === dragged.id ? { parentId: nextParentId } : byId.get(e.target)
      if (!source || !targetNode) return true
      return (source.parentId ?? undefined) === (targetNode.parentId ?? undefined)
    }))
    setDirty(true)
  }, [nodesRef, setNodes, setEdges, setDirty])

  // Delete specific nodes by ID
  const deleteNodes = useCallback((nodeIds: string[]) => {
    const idsToRemove = new Set(nodeIds)

    // Cascade: remove session children and group members of removed nodes
    const currentNodes = nodesRef.current
    let changed = true
    while (changed) {
      changed = false
      for (const n of currentNodes) {
        if (n.parentId && idsToRemove.has(n.parentId) && !idsToRemove.has(n.id)) {
          idsToRemove.add(n.id)
          changed = true
        }
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
  const addNodeAtPosition = useCallback((type: CreatableNodeType, position: XYPosition) => {
    const id = `node-${Date.now()}`
    const newNode: CanvasNode = {
      id,
      type: NODE_TYPES[type].rfType,
      position,
      data: NODE_TYPES[type].create!(),
      ...(NODE_TYPES[type].group ? { style: { ...DEFAULT_GROUP_SIZE }, ...DEFAULT_GROUP_SIZE } : {}),
    }
    setNodes((nds) => (NODE_TYPES[type].group ? [newNode, ...nds] : [...nds, newNode]))
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

    // Groups are laid out as single blocks at their drawn size; their children
    // keep their relative positions, which is what the author arranged.
    const topLevel = currentNodes.filter((node) => !node.parentId)
    const topLevelIds = new Set(topLevel.map((node) => node.id))
    for (const node of topLevel) {
      const width = isGroupReactFlowType(node.type) ? (node.width ?? DEFAULT_GROUP_SIZE.width) : nodeWidth
      const height = isGroupReactFlowType(node.type) ? (node.height ?? DEFAULT_GROUP_SIZE.height) : nodeHeight
      g.setNode(node.id, { width, height })
    }
    for (const edge of currentEdges) {
      if (topLevelIds.has(edge.source) && topLevelIds.has(edge.target)) g.setEdge(edge.source, edge.target)
    }

    dagre.layout(g)

    setNodes((nds) =>
      nds.map((node) => {
        if (node.parentId) return node
        const pos = g.node(node.id)
        if (!pos) return node
        return {
          ...node,
          position: {
            x: pos.x - (g.node(node.id).width ?? nodeWidth) / 2,
            y: pos.y - (g.node(node.id).height ?? nodeHeight) / 2,
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
  const updateNodeStatuses = useCallback((statusMap: Record<string, string>, extraData?: Record<string, unknown>, progressMap?: Record<string, string>) => {
    setNodes((nds) => {
      let changed = false

      const nextNodes = nds.map((n) => {
        const nextStatus = statusMap[n.id]
        const currentStatus = (n.data as Record<string, unknown>).status
        const nextProgress = progressMap?.[n.id]
        const currentProgress = (n.data as Record<string, unknown>).progress

        let nodeChanged = currentStatus !== nextStatus || currentProgress !== nextProgress
        const mergedData: Record<string, unknown> = { ...n.data, status: nextStatus, progress: nextProgress }

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
    onNodeDragStop,
  }
}
