import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useIntl } from "react-intl"
import {
  Background,
  Controls,
  MiniMap,
  PanOnScrollMode,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type NodeMouseHandler,
  type ReactFlowInstance,
  type XYPosition,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import {
  Link2,
  Trash2,
  Copy,
  LayoutGrid,
  Maximize,
  FileInput,
  Brain,
} from "lucide-react"
import { InputNodeComponent } from "./nodes/InputNode"
import { AINodeComponent } from "./nodes/AINode"
import { AISessionNodeComponent } from "./nodes/AISessionNode"

type CanvasNode = Node<Record<string, unknown>>

interface ContextMenuState {
  target: "node" | "pane"
  nodeId?: string
  nodeType?: string
  x: number
  y: number
  flowPosition?: XYPosition
}

interface CanvasEditorProps {
  nodes: CanvasNode[]
  edges: Edge[]
  onNodesChange: OnNodesChange<CanvasNode>
  onEdgesChange: OnEdgesChange
  onConnect: OnConnect
  onNodeClick?: NodeMouseHandler<CanvasNode>
  onPaneClick?: () => void
  onCreateSessionNode?: (parentNodeId: string) => void
  hasSessionChild?: (nodeId: string) => boolean
  onInit?: (instance: ReactFlowInstance) => void
  onDeleteNodes?: (nodeIds: string[]) => void
  onDuplicateNodes?: (nodeIds: string[]) => void
  onAddNodeAtPosition?: (type: "input" | "ai", position: XYPosition) => void
  onAutoLayout?: () => void
}

function CanvasEditorInner({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
  onPaneClick,
  onCreateSessionNode,
  hasSessionChild,
  onInit,
  onDeleteNodes,
  onDuplicateNodes,
  onAddNodeAtPosition,
  onAutoLayout,
}: CanvasEditorProps) {
  const nodeTypes = useMemo(
    () => ({
      inputNode: InputNodeComponent,
      aiNode: AINodeComponent,
      aiSessionNode: AISessionNodeComponent,
    }),
    []
  )

  const intl = useIntl()
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { fitView, screenToFlowPosition } = useReactFlow()

  // Node right-click
  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: CanvasNode) => {
      event.preventDefault()
      const bounds = containerRef.current?.getBoundingClientRect()
      setContextMenu({
        target: "node",
        nodeId: node.id,
        nodeType: node.type,
        x: event.clientX - (bounds?.left ?? 0),
        y: event.clientY - (bounds?.top ?? 0),
      })
    },
    []
  )

  // Pane right-click
  const handlePaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      event.preventDefault()
      const bounds = containerRef.current?.getBoundingClientRect()
      const flowPos = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })
      setContextMenu({
        target: "pane",
        x: event.clientX - (bounds?.left ?? 0),
        y: event.clientY - (bounds?.top ?? 0),
        flowPosition: flowPos,
      })
    },
    [screenToFlowPosition]
  )

  const dismissContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  // Context menu actions
  const handleCreateSession = useCallback(() => {
    if (contextMenu?.nodeId && onCreateSessionNode) {
      onCreateSessionNode(contextMenu.nodeId)
    }
    setContextMenu(null)
  }, [contextMenu, onCreateSessionNode])

  const handleDeleteNode = useCallback(() => {
    if (contextMenu?.nodeId && onDeleteNodes) {
      onDeleteNodes([contextMenu.nodeId])
    }
    setContextMenu(null)
  }, [contextMenu, onDeleteNodes])

  const handleDuplicateNode = useCallback(() => {
    if (contextMenu?.nodeId && onDuplicateNodes) {
      onDuplicateNodes([contextMenu.nodeId])
    }
    setContextMenu(null)
  }, [contextMenu, onDuplicateNodes])

  const handleAddNodeAtPosition = useCallback(
    (type: "input" | "ai") => {
      if (contextMenu?.flowPosition && onAddNodeAtPosition) {
        onAddNodeAtPosition(type, contextMenu.flowPosition)
      }
      setContextMenu(null)
    },
    [contextMenu, onAddNodeAtPosition]
  )

  const handleFitView = useCallback(() => {
    fitView({ padding: 0.2, duration: 300 })
    setContextMenu(null)
  }, [fitView])

  const handleAutoLayout = useCallback(() => {
    onAutoLayout?.()
    setContextMenu(null)
  }, [onAutoLayout])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isModKey = e.metaKey || e.ctrlKey
      if (!isModKey) return

      // Don't intercept if typing in an input
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA") return

      if (e.key === "a") {
        // Select all nodes
        e.preventDefault()
        onNodesChange(
          nodes.map((n) => ({
            type: "select" as const,
            id: n.id,
            selected: true,
          }))
        )
      } else if (e.key === "d") {
        // Duplicate selected
        e.preventDefault()
        const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id)
        if (selectedIds.length > 0) {
          onDuplicateNodes?.(selectedIds)
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [nodes, onNodesChange, onDuplicateNodes])

  // Check if the context menu node can have "Continue Session"
  const showContinueSession =
    contextMenu?.target === "node" &&
    (contextMenu.nodeType === "aiNode" || contextMenu.nodeType === "aiSessionNode") &&
    contextMenu.nodeId &&
    !hasSessionChild?.(contextMenu.nodeId)

  return (
    <div className="h-full w-full relative" ref={containerRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onInit={onInit}
        onNodeClick={(e, n) => {
          dismissContextMenu()
          onNodeClick?.(e, n)
        }}
        onPaneClick={() => {
          dismissContextMenu()
          onPaneClick?.()
        }}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneContextMenu={handlePaneContextMenu}
        proOptions={{ hideAttribution: true }}
        nodeTypes={nodeTypes}
        fitView
        deleteKeyCode={["Backspace", "Delete"]}
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
        zoomActivationKeyCode="Meta"
        selectionOnDrag
        defaultEdgeOptions={{
          animated: false,
          style: { strokeWidth: 2 },
        }}
      >
        <Background bgColor="var(--sidebar)" />
        <Controls
          showInteractive={false}
          className="!bg-background/80 !border-border/50 !shadow-card !rounded-lg [&_button]:!bg-transparent [&_button]:!border-border/40 [&_button]:!fill-foreground [&_button:hover]:!bg-muted/50"
        />
        <MiniMap
          className="!bg-background/80 !border-border/40 !shadow-card !rounded-lg"
          maskColor="rgba(0, 0, 0, 0.08)"
          nodeColor={(node) => {
            if (node.type === "inputNode") return "rgb(59 130 246 / 0.5)"
            if (node.type === "aiNode") return "rgb(168 85 247 / 0.5)"
            if (node.type === "aiSessionNode") return "rgb(6 182 212 / 0.5)"
            return "rgb(156 163 175 / 0.4)"
          }}
          pannable
          zoomable
        />
      </ReactFlow>

      {/* Floating toolbar */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-1 rounded-lg border border-border/40 bg-background/80 backdrop-blur-sm shadow-card px-1 py-1">
        <button
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors"
          onClick={() => onAutoLayout?.()}
          title={intl.formatMessage({ id: "canvas.context.autoLayout", defaultMessage: "Auto Layout" })}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          <span>{intl.formatMessage({ id: "canvas.toolbar.layout", defaultMessage: "Layout" })}</span>
        </button>
        <div className="w-px h-4 bg-border/40" />
        <button
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors"
          onClick={() => fitView({ padding: 0.2, duration: 300 })}
          title={intl.formatMessage({ id: "canvas.context.fitView", defaultMessage: "Fit View" })}
        >
          <Maximize className="h-3.5 w-3.5" />
          <span>{intl.formatMessage({ id: "canvas.toolbar.fit", defaultMessage: "Fit" })}</span>
        </button>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={dismissContextMenu}
          />
          <div
            className="absolute z-40 min-w-[180px] rounded-lg border border-border/40 bg-background/95 shadow-float backdrop-blur-sm py-1"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.target === "node" && (
              <>
                {showContinueSession && (
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors text-left"
                    onClick={handleCreateSession}
                  >
                    <Link2 className="h-3.5 w-3.5 text-blue-500" />
                    <span>{intl.formatMessage({ id: "canvas.context.continueSession", defaultMessage: "Continue Session" })}</span>
                  </button>
                )}
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors text-left"
                  onClick={handleDuplicateNode}
                >
                  <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{intl.formatMessage({ id: "canvas.context.duplicate", defaultMessage: "Duplicate" })}</span>
                </button>
                <div className="my-1 h-px bg-border/30" />
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-red-500/10 text-red-500 transition-colors text-left"
                  onClick={handleDeleteNode}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{intl.formatMessage({ id: "common.delete", defaultMessage: "Delete" })}</span>
                </button>
              </>
            )}

            {contextMenu.target === "pane" && (
              <>
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors text-left"
                  onClick={() => handleAddNodeAtPosition("input")}
                >
                  <FileInput className="h-3.5 w-3.5 text-blue-500" />
                  <span>{intl.formatMessage({ id: "canvas.context.addInput", defaultMessage: "Add Input Node" })}</span>
                </button>
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors text-left"
                  onClick={() => handleAddNodeAtPosition("ai")}
                >
                  <Brain className="h-3.5 w-3.5 text-purple-500" />
                  <span>{intl.formatMessage({ id: "canvas.context.addAi", defaultMessage: "Add AI Node" })}</span>
                </button>
                <div className="my-1 h-px bg-border/30" />
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors text-left"
                  onClick={handleAutoLayout}
                >
                  <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{intl.formatMessage({ id: "canvas.context.autoLayout", defaultMessage: "Auto Layout" })}</span>
                </button>
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors text-left"
                  onClick={handleFitView}
                >
                  <Maximize className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{intl.formatMessage({ id: "canvas.context.fitView", defaultMessage: "Fit View" })}</span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export function CanvasEditor(props: CanvasEditorProps) {
  return <CanvasEditorInner {...props} />
}
