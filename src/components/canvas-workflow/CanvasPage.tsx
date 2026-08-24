import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useIntl } from "react-intl"
import { ReactFlowProvider, type Node } from "@xyflow/react"
import { ArrowLeft, ChevronRight, Play, RefreshCw, ListChecks, X, Loader2, Pencil, Check, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import type { CanvasWorkflowListItem } from "@/types/canvas-workflow"
import { WorkflowLibrary } from "./WorkflowLibrary"
import { NodePalette } from "./NodePalette"
import { CanvasEditor } from "./CanvasEditor"
import { NodeConfigPanel } from "./NodeConfigPanel"
import { RunResultPanel } from "./RunResultPanel"
import { ChatPreview } from "./ChatPreview"
import { useCanvasWorkflow } from "./hooks/useCanvasWorkflow"
import { useCanvasExecution } from "./hooks/useCanvasExecution"
import { cn } from "@/lib/utils"
import { parseCanvasChatId } from "@/lib/canvas-utils"

interface CanvasPageProps {
  onBack: () => void
  onOpenChat?: (chatId: number, title?: string, providerId?: string) => void
  workspaceId?: number
  /** "project / workspace", shown in the breadcrumb so the list's filter is visible. */
  workspaceLabel?: string | null
}

interface ProviderInfo {
  id: string
  label: string
  logo: string
}

type RightPanel = "none" | "config" | "results" | "preview"

export function CanvasPage({ onBack, onOpenChat, workspaceId, workspaceLabel }: CanvasPageProps) {
  const intl = useIntl()
  const [workflows, setWorkflows] = useState<CanvasWorkflowListItem[]>([])
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<number | undefined>()
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [rightPanel, setRightPanel] = useState<RightPanel>("none")
  const [previewChatId, setPreviewChatId] = useState<number | null>(null)
  const [isRenamingWorkflow, setIsRenamingWorkflow] = useState(false)
  const [workflowNameDraft, setWorkflowNameDraft] = useState("")
  const [savingWorkflowName, setSavingWorkflowName] = useState(false)
  const workflowNameInputRef = useRef<HTMLInputElement>(null)
  const savingWorkflowNameRef = useRef(false)
  const canvasChatIdCacheRef = useRef<Map<string, number>>(new Map())

  const canvasState = useCanvasWorkflow(selectedWorkflowId)
  const execution = useCanvasExecution(canvasState.workflow?.id)

  // Load data
  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [wfRes, provRes] = await Promise.all([
        api.canvasWorkflowList(workspaceId),
        api.getProviders(),
      ])
      setWorkflows(wfRes.workflows)
      setProviders(provRes)
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  // No auto-select: the page opens on the library. Picking workflows[0] for the
  // user hid both the rest of the list and the workspace it was filtered to.

  useEffect(() => {
    if (!canvasState.workflow) {
      setWorkflowNameDraft("")
      setIsRenamingWorkflow(false)
      return
    }
    setWorkflowNameDraft(canvasState.workflow.name)
    setIsRenamingWorkflow(false)
  }, [canvasState.workflow?.id, canvasState.workflow?.name])

  useEffect(() => {
    if (!isRenamingWorkflow) return
    workflowNameInputRef.current?.focus()
    workflowNameInputRef.current?.select()
  }, [isRenamingWorkflow])

  const resolveCanvasNodeChatId = useCallback(async (runId: number, nodeId: string): Promise<number | null> => {
    const cacheKey = `${runId}:${nodeId}`
    const cachedId = canvasChatIdCacheRef.current.get(cacheKey)
    if (cachedId !== undefined) return cachedId

    const items = await api.chatHistoryList(workspaceId, "canvas")
    const matched = items.find((item) =>
      item.metadata?.runId === runId && item.metadata?.nodeId === nodeId
    )

    if (!matched) return null
    canvasChatIdCacheRef.current.set(cacheKey, matched.id)
    return matched.id
  }, [workspaceId])

  const handleOpenCanvasChat = useCallback(async (chatRef: string, title?: string, providerId?: string) => {
    const parsed = parseCanvasChatId(chatRef)
    if (!parsed || !onOpenChat) return

    try {
      const resolvedChatId = await resolveCanvasNodeChatId(parsed.runId, parsed.nodeId)
      if (resolvedChatId !== null) {
        onOpenChat(resolvedChatId, title, providerId)
      }
    } catch (error) {
      console.error("[Canvas] Failed to open node chat:", error)
    }
  }, [onOpenChat, resolveCanvasNodeChatId])

  // Sync execution status to canvas nodes (inject runId + onOpenChat for AI nodes)
  useEffect(() => {
    const runId = execution.selectedRun?.id
    canvasState.updateNodeStatuses(execution.nodeStatusMap, { runId, onOpenChat: handleOpenCanvasChat })
  }, [canvasState.updateNodeStatuses, execution.nodeStatusMap, execution.selectedRun?.id, handleOpenCanvasChat])

  // Selected ReactFlow node
  const selectedNode = useMemo(
    () => canvasState.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [canvasState.nodes, selectedNodeId]
  )

  // Handlers
  const handleNewWorkflow = useCallback(async () => {
    const { workflow } = await api.canvasWorkflowCreate({
      name: intl.formatMessage({ id: "canvas.untitledWorkflow", defaultMessage: "Untitled Workflow" }),
      workspaceId,
      nodes: [],
      edges: [],
    })
    setWorkflows((prev) => [workflow, ...prev])
    setSelectedWorkflowId(workflow.id)
  }, [workspaceId])

  const handleDeleteWorkflow = useCallback(async (id: number) => {
    await api.canvasWorkflowDelete(id)
    setWorkflows((prev) => prev.filter((w) => w.id !== id))
    if (selectedWorkflowId === id) {
      setSelectedWorkflowId(undefined)
    }
  }, [selectedWorkflowId])

  /**
   * Back to the library. Re-lists on the way out so the row that was just
   * edited shows its new name, node count and run — the list is a snapshot
   * taken on mount, and the editor is exactly what invalidates it.
   */
  const handleBackToLibrary = useCallback(() => {
    setSelectedWorkflowId(undefined)
    setSelectedNodeId(null)
    setRightPanel("none")
    void loadData()
  }, [loadData])

  const handleExecute = useCallback(async () => {
    await canvasState.save()
    execution.execute()
    setRightPanel("results")
  }, [canvasState, execution])

  const handleNodeSelect = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id)
    const nodeStatus = execution.nodeStatusMap[node.id]
    const currentRunId = execution.run?.id

    if (nodeStatus === 'running' && currentRunId && (node.type === 'aiNode' || node.type === 'aiSessionNode')) {
      // Running AI/session node → open live preview
      // For session nodes, the chat is stored under the root AI node's chatId
      let chatNodeId = node.id
      if (node.type === 'aiSessionNode') {
        const nodeData = node.data as Record<string, unknown>
        const sessionData = nodeData.nodeData as { parentNodeId?: string } | undefined
        if (sessionData?.parentNodeId) {
          chatNodeId = sessionData.parentNodeId
        }
      }
      void resolveCanvasNodeChatId(currentRunId, chatNodeId)
        .then((chatId) => {
          if (chatId === null) {
            setPreviewChatId(null)
            setRightPanel("config")
            return
          }
          setPreviewChatId(chatId)
          setRightPanel("preview")
        })
        .catch((error) => {
          console.error("[Canvas] Failed to resolve preview chat:", error)
          setPreviewChatId(null)
          setRightPanel("config")
        })
    } else {
      setRightPanel("config")
    }
  }, [execution.nodeStatusMap, execution.run?.id, resolveCanvasNodeChatId])

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null)
    if (rightPanel === "config") {
      setRightPanel("none")
    }
  }, [rightPanel])

  const handleClosePanel = useCallback(() => {
    setSelectedNodeId(null)
    setRightPanel("none")
  }, [])

  const toggleResults = useCallback(() => {
    setRightPanel((prev) => (prev === "results" ? "none" : "results"))
    if (rightPanel !== "results") {
      setSelectedNodeId(null)
    }
  }, [rightPanel])

  const hasRuns = execution.runs.length > 0 || execution.run !== null

  /**
   * Two views behind one page: the library, and the editor for one workflow.
   * Keyed off the selected id rather than the loaded workflow so the editor
   * shell stays put while that workflow is being fetched — keying off
   * `canvasState.workflow` would flash the library on every open.
   */
  const editing = selectedWorkflowId !== undefined

  const startRenameWorkflow = useCallback(() => {
    if (!canvasState.workflow) return
    setWorkflowNameDraft(canvasState.workflow.name)
    setIsRenamingWorkflow(true)
  }, [canvasState.workflow])

  const cancelRenameWorkflow = useCallback(() => {
    setWorkflowNameDraft(canvasState.workflow?.name ?? "")
    setIsRenamingWorkflow(false)
  }, [canvasState.workflow?.name])

  const saveWorkflowName = useCallback(async () => {
    if (!canvasState.workflow || savingWorkflowNameRef.current) return

    savingWorkflowNameRef.current = true

    const nextName = workflowNameDraft.trim() || intl.formatMessage({ id: "canvas.untitledWorkflow", defaultMessage: "Untitled Workflow" })
    const currentName = canvasState.workflow.name
    setIsRenamingWorkflow(false)

    if (nextName === currentName) {
      setWorkflowNameDraft(currentName)
      savingWorkflowNameRef.current = false
      return
    }

    setSavingWorkflowName(true)
    try {
      const { workflow: updated } = await api.canvasWorkflowUpdate(canvasState.workflow.id, { name: nextName })
      if (updated) {
        canvasState.setWorkflow(updated)
        setWorkflows((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
        setWorkflowNameDraft(updated.name)
      }
    } catch {
      setWorkflowNameDraft(currentName)
    } finally {
      savingWorkflowNameRef.current = false
      setSavingWorkflowName(false)
    }
  }, [canvasState, workflowNameDraft])

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground">
      <div className="h-10 drag-region shrink-0 bg-background" />

      {/* Top bar: a breadcrumb, so the workspace the list is filtered to, the
          current position, and the way back are all readable at once. */}
      <div className="h-14 border-b border-border/50 flex items-center justify-between px-6 bg-background sticky top-0 z-10 no-drag">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 text-muted-foreground hover:text-foreground -ml-2 rounded-full px-3 transition-colors"
            onClick={onBack}
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="font-medium">{intl.formatMessage({ id: "common.back", defaultMessage: "Back" })}</span>
          </Button>
          <div className="h-4 w-px bg-border/50" />
          {workspaceLabel && (
            <>
              <span className="truncate text-sm text-muted-foreground">{workspaceLabel}</span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
            </>
          )}
          {editing ? (
            <button
              type="button"
              onClick={handleBackToLibrary}
              className="shrink-0 rounded-md px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground"
            >
              {intl.formatMessage({ id: "canvas.workflows", defaultMessage: "Workflows" })}
            </button>
          ) : (
            <span className="text-sm font-semibold text-foreground">
              {intl.formatMessage({ id: "canvas.workflows", defaultMessage: "Workflows" })}
            </span>
          )}
          {canvasState.workflow && (
            <>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
              {isRenamingWorkflow ? (
                <Input
                  ref={workflowNameInputRef}
                  value={workflowNameDraft}
                  onChange={(event) => setWorkflowNameDraft(event.target.value)}
                  onBlur={() => void saveWorkflowName()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      void saveWorkflowName()
                    } else if (event.key === "Escape") {
                      event.preventDefault()
                      cancelRenameWorkflow()
                    }
                  }}
                  className="h-8 w-[220px] bg-muted/25 border border-transparent hover:bg-muted/40 hover:border-border/40 focus-visible:bg-background focus-visible:border-border/50 focus-visible:ring-2 focus-visible:ring-border/30 shadow-none text-sm"
                  maxLength={80}
                  disabled={savingWorkflowName}
                />
              ) : (
                <button
                  type="button"
                  onClick={startRenameWorkflow}
                  className="group inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-semibold text-foreground hover:bg-muted/45 transition-colors"
                  title={intl.formatMessage({ id: "canvas.renameWorkflow", defaultMessage: "Rename workflow" })}
                >
                  <span className="max-w-[260px] truncate">{canvasState.workflow.name}</span>
                  <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-70 transition-opacity" />
                </button>
              )}
            </>
          )}
        </div>
        {/* Editing acts on one workflow; the library acts on the set. Only the
            actions that apply to the current view are shown. */}
        <div className="flex items-center gap-2 no-drag">
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            onClick={() => void loadData()}
            title={intl.formatMessage({ id: "common.refresh", defaultMessage: "Refresh" })}
          >
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
          </Button>

          {/* Results button */}
          {editing && hasRuns && (
            <Button
              variant={rightPanel === "results" ? "secondary" : "ghost"}
              size="sm"
              className={cn(
                "gap-1.5 relative",
                rightPanel === "results"
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={toggleResults}
            >
              {execution.executing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ListChecks className="h-3.5 w-3.5" />
              )}
              {intl.formatMessage({ id: "canvas.results", defaultMessage: "Results" })}
              {execution.runs.length > 0 && (
                <span className="text-[10px] bg-muted/60 px-1.5 py-0.5 rounded-full">
                  {execution.runs.length}
                </span>
              )}
            </Button>
          )}

          {/* Auto-save status */}
          <div className={cn("flex items-center gap-1.5 px-2 text-xs text-muted-foreground", !editing && "hidden")}>
            {canvasState.saving ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>{intl.formatMessage({ id: "canvas.saving", defaultMessage: "Saving..." })}</span>
              </>
            ) : canvasState.saveError ? (
              <div className="group relative flex items-center gap-1.5 text-destructive cursor-default">
                <AlertCircle className="h-3 w-3" />
                <span>{intl.formatMessage({ id: "canvas.saveError", defaultMessage: "Error" })}</span>
                <div className="invisible group-hover:visible absolute top-full right-0 mt-1 w-max max-w-[280px] rounded-md bg-popover border border-border/50 px-3 py-2 text-xs text-popover-foreground shadow-float z-50">
                  {canvasState.saveError}
                </div>
              </div>
            ) : canvasState.dirty ? (
              <>
                <div className="h-1.5 w-1.5 rounded-full bg-status-warn" />
                <span>{intl.formatMessage({ id: "canvas.unsaved", defaultMessage: "Unsaved" })}</span>
              </>
            ) : canvasState.lastSavedAt ? (
              <>
                <Check className="h-3 w-3 text-status-ok" />
                <span>{intl.formatMessage({ id: "canvas.saved", defaultMessage: "Saved" })}</span>
              </>
            ) : null}
          </div>
          {editing && (
            <Button
              variant="secondary"
              size="sm"
              className="gap-1.5"
              onClick={handleExecute}
              disabled={execution.executing || !canvasState.workflow}
            >
              <Play className="h-3.5 w-3.5" />
              {execution.executing ? intl.formatMessage({ id: "canvas.running", defaultMessage: "Running..." }) : intl.formatMessage({ id: "canvas.execute", defaultMessage: "Execute" })}
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 animate-pulse">
            <div className="size-8 rounded-full bg-muted" />
            <div className="text-sm text-muted-foreground">{intl.formatMessage({ id: "common.loading", defaultMessage: "Loading..." })}</div>
          </div>
        </div>
      ) : !editing ? (
        <div className="flex-1 min-h-0">
          <WorkflowLibrary
            workflows={workflows}
            workspaceLabel={workspaceLabel ?? null}
            onOpen={setSelectedWorkflowId}
            onNew={handleNewWorkflow}
            onDelete={handleDeleteWorkflow}
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0 relative">
          <div className="flex h-full">
            {/* Left rail, editor-only: just the node palette. The workflow list
                used to live here too, which put navigation ("which workflow?")
                and editing ("add a node") in one column and cost canvas width
                for a list nobody reads mid-edit. Navigation is the breadcrumb
                now, and this rail holds one job. */}
            <div className="w-52 shrink-0 border-r border-border/50 bg-sidebar">
              <NodePalette onAddNode={canvasState.addNode} />
            </div>

            <div className="min-w-0 flex-1 bg-background">
              <ReactFlowProvider>
                <CanvasEditor
                  nodes={canvasState.nodes}
                  edges={canvasState.edges}
                  onNodesChange={canvasState.onNodesChange}
                  onEdgesChange={canvasState.onEdgesChange}
                  onConnect={canvasState.onConnect}
                  onNodeClick={handleNodeSelect}
                  onPaneClick={handlePaneClick}
                  onCreateSessionNode={canvasState.addSessionNode}
                  hasSessionChild={canvasState.hasSessionChild}
                  onInit={canvasState.setReactFlowInstance}
                  onDeleteNodes={canvasState.deleteNodes}
                  onDuplicateNodes={canvasState.duplicateNodes}
                  onAddNodeAtPosition={canvasState.addNodeAtPosition}
                  onAutoLayout={canvasState.autoLayout}
                />
              </ReactFlowProvider>
            </div>
          </div>

          {/* Floating slide-out panel from right */}
          <div
            className={cn(
              "absolute top-0 right-0 h-full w-[360px] z-20 bg-background border-l border-border/50 shadow-drawer transition-transform duration-300 ease-in-out",
              rightPanel !== "none" ? "translate-x-0" : "translate-x-full"
            )}
          >
            {/* Close button */}
            {rightPanel !== "none" && rightPanel !== "config" && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute -left-9 top-2 h-7 w-7 rounded-full bg-background border border-border/50 shadow-card z-10 hover:bg-muted/50"
                onClick={handleClosePanel}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}

            {rightPanel === "config" && (
              <NodeConfigPanel
                node={selectedNode}
                providers={providers}
                onUpdate={canvasState.updateNodeData}
                onClose={handleClosePanel}
              />
            )}

            {rightPanel === "results" && (
              <RunResultPanel
                run={execution.selectedRun}
                runs={execution.runs}
                selectedRunId={execution.selectedRunId}
                onSelectRun={execution.selectRun}
              />
            )}

            {rightPanel === "preview" && (
              <ChatPreview
                chatId={previewChatId}
                isRunning={execution.executing}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
