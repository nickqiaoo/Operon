import { useCallback, useEffect, useState } from "react"
import type { Edge, Node } from "@xyflow/react"
import type { CanvasWorkflowRun } from "@/types/canvas-workflow"
import type { CanvasNode } from "./utils/canvasConversions"
import { useAvailableVariables, type CallerVariable } from "./hooks/useAvailableVariables"
import { VariableScopeProvider } from "./panels/variable-scope"
import { Link2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { fromReactFlowNodeType, metaForReactFlowType } from "./node-registry"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type {
  CanvasAINodeData,
  CanvasAISessionNodeData,
  CanvasCodeNodeData,
  CanvasEndNodeData,
  CanvasHttpNodeData,
  CanvasIfNodeData,
  CanvasInputNodeData,
  CanvasIterationNodeData,
  CanvasLoopNodeData,
  CanvasSubWorkflowNodeData,
  CanvasApprovalNodeData,
  CanvasNodeData,
  CanvasShellNodeData,
  CanvasTemplateNodeData,
} from "@/types/canvas-workflow"
import { ShellPanel } from "./panels/ShellPanel"
import { TemplatePanel } from "./panels/TemplatePanel"
import { CodePanel } from "./panels/CodePanel"
import { IfPanel } from "./panels/IfPanel"
import { HttpPanel } from "./panels/HttpPanel"
import { EndPanel } from "./panels/EndPanel"
import { IterationPanel } from "./panels/IterationPanel"
import { LoopPanel } from "./panels/LoopPanel"
import { SubWorkflowPanel } from "./panels/SubWorkflowPanel"
import { ApprovalPanel } from "./panels/ApprovalPanel"
import { Field, NumberField, TextAreaField } from "./panels/fields"
import { api } from "@/lib/api"

interface ProviderInfo {
  id: string
  label: string
  logo: string
}

interface NodeConfigPanelProps {
  node: Node | null
  providers: ProviderInfo[]
  /** The workflow being edited, so a sub-workflow picker can exclude it. */
  workflowId?: number
  /** The whole graph plus the latest run, to offer the variables this node can use. */
  nodes: CanvasNode[]
  edges: Edge[]
  lastRun?: CanvasWorkflowRun | null
  onUpdate: (nodeId: string, updates: Record<string, unknown>) => void
  onClose: () => void
}

/**
 * Variables other workflows hand to this one through Sub-workflow nodes.
 * The child never declares them, so the only honest source is the callers.
 */
function useCallerVariables(workflowId: number | undefined): CallerVariable[] {
  const [callers, setCallers] = useState<CallerVariable[]>([])
  useEffect(() => {
    if (!workflowId) { setCallers([]); return }
    let cancelled = false
    api.canvasWorkflowCallers(workflowId)
      .then(({ callers: list }) => {
        if (cancelled) return
        const byName = new Map<string, Set<string>>()
        for (const caller of list) {
          for (const key of caller.keys) {
            if (!byName.has(key)) byName.set(key, new Set())
            byName.get(key)!.add(caller.workflowName)
          }
        }
        setCallers([...byName.entries()].map(([name, from]) => ({ name, from: [...from] })))
      })
      .catch(() => { if (!cancelled) setCallers([]) })
    return () => { cancelled = true }
  }, [workflowId])
  return callers
}

export function NodeConfigPanel({ node, providers, workflowId, nodes, edges, lastRun, onUpdate, onClose }: NodeConfigPanelProps) {
  const callerVariables = useCallerVariables(workflowId)
  const variables = useAvailableVariables(node?.id ?? null, nodes, edges, lastRun, callerVariables)
  if (!node) return null

  const nodeType = fromReactFlowNodeType(node.type ?? "")
  const data = node.data as Record<string, unknown>
  const nodeData = data.nodeData as CanvasNodeData
  const update = (updates: Partial<CanvasNodeData>) =>
    onUpdate(node.id, { nodeData: { ...nodeData, ...updates } })

  const meta = metaForReactFlowType(node.type)
  const HeaderIcon = meta.icon
  const headerIcon = <HeaderIcon className={cn("h-4 w-4", meta.iconClass)} />
  const headerTitle = meta.title

  return (
    <VariableScopeProvider value={variables}>
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          {headerIcon}
          <span className="text-sm font-medium">{headerTitle}</span>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 code-scrollbar">
        {/* Name */}
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/60">
            Name
          </label>
          <Input
            value={(data.name as string) || ""}
            onChange={(e) => onUpdate(node.id, { name: e.target.value })}
            className="bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none h-8 text-sm"
          />
        </div>

        {nodeType === "input" && (
          <InputNodeConfig nodeData={nodeData as CanvasInputNodeData} onUpdate={update} />
        )}
        {nodeType === "ai-session" && (
          <AISessionNodeConfig
            nodeData={nodeData as CanvasAISessionNodeData}
            parentName={(data.parentName as string) || undefined}
            parentProviderId={(data.parentProviderId as string) || undefined}
            onUpdate={update}
          />
        )}
        {nodeType === "ai" && (
          <AINodeConfig nodeData={nodeData as CanvasAINodeData} providers={providers} onUpdate={update} />
        )}
        {nodeType === "shell" && <ShellPanel nodeData={nodeData as CanvasShellNodeData} onUpdate={update} />}
        {nodeType === "template" && <TemplatePanel nodeData={nodeData as CanvasTemplateNodeData} onUpdate={update} />}
        {nodeType === "code" && <CodePanel nodeData={nodeData as CanvasCodeNodeData} onUpdate={update} />}
        {nodeType === "if" && <IfPanel nodeData={nodeData as CanvasIfNodeData} onUpdate={update} />}
        {nodeType === "http" && <HttpPanel nodeData={nodeData as CanvasHttpNodeData} onUpdate={update} />}
        {nodeType === "end" && <EndPanel nodeData={nodeData as CanvasEndNodeData} onUpdate={update} />}
        {nodeType === "iteration" && <IterationPanel nodeData={nodeData as CanvasIterationNodeData} onUpdate={update} />}
        {nodeType === "loop" && <LoopPanel nodeData={nodeData as CanvasLoopNodeData} onUpdate={update} />}
        {nodeType === "subworkflow" && (
          <SubWorkflowPanel nodeData={nodeData as CanvasSubWorkflowNodeData} currentWorkflowId={workflowId} onUpdate={update} />
        )}
        {nodeType === "approval" && <ApprovalPanel nodeData={nodeData as CanvasApprovalNodeData} onUpdate={update} />}
      </div>
    </div>
    </VariableScopeProvider>
  )
}

function InputNodeConfig({
  nodeData,
  onUpdate,
}: {
  nodeData: CanvasInputNodeData
  onUpdate: (updates: Partial<CanvasInputNodeData>) => void
}) {
  const [prompt, setPrompt] = useState(nodeData.prompt || "")

  useEffect(() => {
    setPrompt(nodeData.prompt || "")
  }, [nodeData.prompt])

  return (
    <div className="space-y-1.5">
      <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/60">
        Prompt
      </label>
      <Textarea
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value)
          onUpdate({ prompt: e.target.value })
        }}
        placeholder="Enter the initial prompt for this workflow..."
        className="bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none resize-none min-h-[120px] text-sm code-scrollbar"
      />
    </div>
  )
}

interface ProviderModel {
  id: string
  name: string
  description?: string
}

interface ProviderMode {
  id: string
  name: string
  description?: string
}

interface ProviderDescriptorPartial {
  models: ProviderModel[]
  modes: ProviderMode[]
  currentModelId: string
  currentModeId: string
}

interface ProviderModelApiItem {
  id?: string
  modelId?: string
  name?: string
  label?: string
  description?: string
}

interface ProviderModeApiItem {
  id?: string
  name?: string
  label?: string
  description?: string
}

interface ProviderDescriptorApiResponse {
  models?: ProviderModelApiItem[]
  modes?: ProviderModeApiItem[]
  currentModelId?: string
  currentModeId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizeDescriptor(raw: unknown): ProviderDescriptorPartial {
  if (!isRecord(raw)) {
    return { models: [], modes: [], currentModelId: "", currentModeId: "" }
  }

  const response = raw as ProviderDescriptorApiResponse

  const models = (response.models ?? [])
    .map((model): ProviderModel | null => {
      const id = model.id ?? model.modelId
      if (!id) return null
      return {
        id,
        name: model.name ?? model.label ?? id,
        description: model.description,
      }
    })
    .filter((model): model is ProviderModel => model !== null)

  const modes = (response.modes ?? [])
    .map((mode): ProviderMode | null => {
      if (!mode.id) return null
      return {
        id: mode.id,
        name: mode.name ?? mode.label ?? mode.id,
        description: mode.description,
      }
    })
    .filter((mode): mode is ProviderMode => mode !== null)

  return {
    models,
    modes,
    currentModelId: response.currentModelId ?? "",
    currentModeId: response.currentModeId ?? "",
  }
}

function AISessionNodeConfig({
  nodeData,
  parentName,
  parentProviderId,
  onUpdate,
}: {
  nodeData: CanvasAISessionNodeData
  parentName?: string
  parentProviderId?: string
  onUpdate: (updates: Partial<CanvasAISessionNodeData>) => void
}) {
  const [prompt, setPrompt] = useState(nodeData.prompt || "")

  useEffect(() => {
    setPrompt(nodeData.prompt || "")
  }, [nodeData.prompt])

  return (
    <div className="space-y-4">
      {/* Session chain info */}
      <div className="rounded-lg bg-blue-500/5 border border-blue-500/10 px-3 py-2.5 space-y-1.5">
        <div className="text-[10px] uppercase font-bold tracking-wider text-blue-500/60">
          Continues Session
        </div>
        <div className="flex items-center gap-1.5 text-xs text-blue-500/80">
          <Link2 className="h-3 w-3" />
          <span className="font-medium">{parentName || nodeData.parentNodeId}</span>
        </div>
        {parentProviderId && (
          <div className="text-[10px] text-muted-foreground/50">
            Provider: {parentProviderId} (inherited)
          </div>
        )}
      </div>

      {/* Prompt */}
      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/60">
          Prompt
        </label>
        <Textarea
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value)
            onUpdate({ prompt: e.target.value })
          }}
          placeholder='Enter the next message for this session... Use {{summary}} to reference output from node name "summary".'
          className="bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none resize-none min-h-[120px] text-sm code-scrollbar"
        />
        <p className="text-[10px] text-muted-foreground/50">
          {'Variables: {{ summary }} = output of the node named "summary" (any node that ran before this one). JSON outputs are objects: {{ review.passed }}.'}
        </p>
      </div>
    </div>
  )
}

function AINodeConfig({
  nodeData,
  providers,
  onUpdate,
}: {
  nodeData: CanvasAINodeData
  providers: ProviderInfo[]
  onUpdate: (updates: Partial<CanvasAINodeData>) => void
}) {
  const [userPrompt, setUserPrompt] = useState(nodeData.userPrompt || "")
  const [descriptor, setDescriptor] = useState<ProviderDescriptorPartial | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setUserPrompt(nodeData.userPrompt || "")
  }, [nodeData.userPrompt])

  const fetchDescriptor = useCallback(async (providerId: string) => {
    if (!providerId) {
      setDescriptor(null)
      return
    }
    setLoading(true)
    try {
      const raw = await api.getProviderModels(providerId)
      const desc = normalizeDescriptor(raw)
      setDescriptor(desc)
    } catch {
      setDescriptor(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (nodeData.providerId) {
      fetchDescriptor(nodeData.providerId)
    } else {
      setDescriptor(null)
    }
  }, [nodeData.providerId, fetchDescriptor])

  const handleProviderChange = (providerId: string) => {
    onUpdate({ providerId, modelId: undefined, modeId: undefined })
  }

  const selectTriggerClassName = "h-8 text-sm bg-muted/25 border border-transparent hover:bg-muted/45 hover:border-border/40 shadow-none transition-colors focus-visible:border-border/50 focus-visible:ring-2 focus-visible:ring-border/30"
  const selectContentClassName = "border border-border/40 bg-background/95 shadow-float backdrop-blur-sm"

  return (
    <div className="space-y-4">
      {/* Provider */}
      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/60">
          Provider
        </label>
        <Select
          value={nodeData.providerId || ""}
          onValueChange={handleProviderChange}
        >
          <SelectTrigger className={selectTriggerClassName}>
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent className={selectContentClassName}>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Model */}
      {descriptor && descriptor.models.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/60">
            Model
          </label>
          <Select
            value={nodeData.modelId || descriptor.currentModelId || ""}
            onValueChange={(v) => onUpdate({ modelId: v })}
            disabled={loading}
          >
            <SelectTrigger className={selectTriggerClassName}>
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent className={selectContentClassName}>
              {descriptor.models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name || m.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Mode */}
      {descriptor && descriptor.modes.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/60">
            Mode
          </label>
          <Select
            value={nodeData.modeId || descriptor.currentModeId || ""}
            onValueChange={(v) => onUpdate({ modeId: v })}
            disabled={loading}
          >
            <SelectTrigger className={selectTriggerClassName}>
              <SelectValue placeholder="Select mode" />
            </SelectTrigger>
            <SelectContent className={selectContentClassName}>
              {descriptor.modes.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* User Prompt */}
      <div className="space-y-1.5">
        <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/60">
          User Prompt
        </label>
        <Textarea
          value={userPrompt}
          onChange={(e) => {
            setUserPrompt(e.target.value)
            onUpdate({ userPrompt: e.target.value })
          }}
          placeholder='Enter the prompt template... Use {{summary}} to reference output from node name "summary".'
          className="bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none resize-none min-h-[120px] text-sm code-scrollbar"
        />
        <p className="text-[10px] text-muted-foreground/50">
          {'Variables: {{ summary }} = output of the node named "summary" (any node that ran before this one). JSON outputs are objects: {{ review.passed }}.'}
        </p>
      </div>

      {/* Structured output */}
      <Field
        label="Structured output (JSON Schema, optional)"
        hint="When set, the reply must be JSON matching this schema; invalid replies get a correction round. Downstream nodes then read fields directly: {{ review.passed }}."
      >
        <TextAreaField
          value={nodeData.outputSchema || ""}
          onChange={(outputSchema) => onUpdate({ outputSchema: outputSchema.trim() === "" ? undefined : outputSchema })}
          placeholder={'{"type": "object", "properties": {"passed": {"type": "boolean"}, "issues": {"type": "array", "items": {"type": "string"}}}, "required": ["passed"]}'}
          mono
          minHeight="min-h-[100px]"
        />
      </Field>
      {nodeData.outputSchema && (
        <Field label="Correction rounds" hint="Default 2.">
          <NumberField value={nodeData.maxRetries} onChange={(maxRetries) => onUpdate({ maxRetries })} placeholder="2" />
        </Field>
      )}
    </div>
  )
}
