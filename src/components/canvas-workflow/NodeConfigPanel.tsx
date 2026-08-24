import { useCallback, useEffect, useState } from "react"
import type { Node } from "@xyflow/react"
import { FileInput, Brain, Link2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { CanvasAINodeData, CanvasAISessionNodeData, CanvasInputNodeData } from "@/types/canvas-workflow"
import { api } from "@/lib/api"

interface ProviderInfo {
  id: string
  label: string
  logo: string
}

interface NodeConfigPanelProps {
  node: Node | null
  providers: ProviderInfo[]
  onUpdate: (nodeId: string, updates: Record<string, unknown>) => void
  onClose: () => void
}

export function NodeConfigPanel({ node, providers, onUpdate, onClose }: NodeConfigPanelProps) {
  if (!node) return null

  const isInput = node.type === "inputNode"
  const isAISession = node.type === "aiSessionNode"
  const data = node.data as Record<string, unknown>
  const nodeData = data.nodeData as CanvasInputNodeData | CanvasAINodeData | CanvasAISessionNodeData

  const headerIcon = isInput
    ? <FileInput className="h-4 w-4 text-blue-500" />
    : isAISession
      ? <Link2 className="h-4 w-4 text-blue-500" />
      : <Brain className="h-4 w-4 text-purple-500" />

  const headerTitle = isInput ? "Input Node" : isAISession ? "AI Session Node" : "AI Node"

  return (
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

        {isInput ? (
          <InputNodeConfig
            nodeData={nodeData as CanvasInputNodeData}
            onUpdate={(updates) =>
              onUpdate(node.id, { nodeData: { ...nodeData, ...updates } })
            }
          />
        ) : isAISession ? (
          <AISessionNodeConfig
            nodeData={nodeData as CanvasAISessionNodeData}
            parentName={(data.parentName as string) || undefined}
            parentProviderId={(data.parentProviderId as string) || undefined}
            onUpdate={(updates) =>
              onUpdate(node.id, { nodeData: { ...nodeData, ...updates } })
            }
          />
        ) : (
          <AINodeConfig
            nodeData={nodeData as CanvasAINodeData}
            providers={providers}
            onUpdate={(updates) =>
              onUpdate(node.id, { nodeData: { ...nodeData, ...updates } })
            }
          />
        )}
      </div>
    </div>
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
          {'Variables: {{summary}} = output from upstream node named "summary"'}
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
          {'Variables: {{summary}} = output from upstream node named "summary"'}
        </p>
      </div>
    </div>
  )
}
