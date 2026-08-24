import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import { toast } from "sonner"
import type {
  CanvasWorkflow,
  CanvasNodeDef,
  CreateCanvasWorkflowInput,
} from "@/types/canvas-workflow"
import {
  fromReactFlowNodes,
  fromReactFlowEdges,
  toReactFlowNodes,
  toReactFlowEdges,
  type CanvasNode,
  type CanvasEdge,
} from "@/components/canvas-workflow/utils/canvasConversions"

interface UseCanvasAutoSaveParams {
  workflowId?: number
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>
  setEdges: React.Dispatch<React.SetStateAction<CanvasEdge[]>>
  dirty: boolean
  setDirty: (dirty: boolean) => void
  initialLoadRef: React.MutableRefObject<boolean>
}

interface SaveOptions {
  fromAutoSave?: boolean
}

function validateUniqueNodeNames(nodes: CanvasNodeDef[]): string | null {
  const seen = new Map<string, string>()

  for (const node of nodes) {
    const trimmedName = node.name.trim()
    if (trimmedName.length === 0) {
      return `Node "${node.id}" name cannot be empty`
    }

    const normalized = trimmedName.toLowerCase()
    const existing = seen.get(normalized)
    if (existing) {
      return `Node name must be unique: "${trimmedName}" duplicates "${existing}"`
    }

    seen.set(normalized, trimmedName)
  }

  return null
}

export function useCanvasAutoSave({
  workflowId,
  nodes,
  edges,
  setNodes,
  setEdges,
  dirty,
  setDirty,
  initialLoadRef,
}: UseCanvasAutoSaveParams) {
  const [workflow, setWorkflow] = useState<CanvasWorkflow | null>(null)
  const [saving, setSaving] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load workflow
  useEffect(() => {
    if (workflowId) {
      initialLoadRef.current = true
      api.canvasWorkflowGet(workflowId).then(({ workflow: data }) => {
        setWorkflow(data)
        setNodes(toReactFlowNodes(data.nodes))
        setEdges(toReactFlowEdges(data.edges, data.nodes))
        setDirty(false)
        setLastSavedAt(null)
        // Allow changes to be tracked after initial load settles
        setTimeout(() => { initialLoadRef.current = false }, 200)
      })
    }
  }, [workflowId, setNodes, setEdges, setDirty, initialLoadRef])

  // Save workflow
  const save = useCallback(async (name?: string, options?: SaveOptions) => {
    setSaving(true)
    try {
      const convertedNodes = fromReactFlowNodes(nodes)
      const nameError = validateUniqueNodeNames(convertedNodes)
      if (nameError) {
        throw new Error(nameError)
      }

      const payload: CreateCanvasWorkflowInput = {
        name: name || workflow?.name || "Untitled",
        nodes: convertedNodes,
        edges: fromReactFlowEdges(edges),
      }

      if (workflow?.id) {
        const result = await api.canvasWorkflowUpdate(workflow.id, payload) as { workflow?: CanvasWorkflow; error?: string }
        if (!result.workflow) {
          throw new Error(result.error || "Failed to save workflow")
        }
        const updated = result.workflow
        if (updated) setWorkflow(updated)
      } else {
        const result = await api.canvasWorkflowCreate(payload) as { workflow?: CanvasWorkflow; error?: string }
        if (!result.workflow) {
          throw new Error(result.error || "Failed to create workflow")
        }
        const created = result.workflow
        setWorkflow(created)
      }
      setDirty(false)
      setLastSavedAt(new Date())
      setSaveError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      setSaveError(message)
      if (!options?.fromAutoSave) {
        toast.error("Failed to save workflow", { description: message })
      }
      throw error
    } finally {
      setSaving(false)
    }
  }, [workflow, nodes, edges, setDirty])

  // Auto-save: debounce 2 seconds after changes
  useEffect(() => {
    if (!dirty || !workflow?.id || saving) return

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }

    autoSaveTimerRef.current = setTimeout(() => {
      void save(undefined, { fromAutoSave: true }).catch(() => {})
    }, 2000)

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
      }
    }
  }, [dirty, workflow?.id, saving, save])

  return {
    workflow,
    setWorkflow,
    saving,
    lastSavedAt,
    saveError,
    save,
  }
}
