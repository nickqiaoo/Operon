import type { LucideIcon } from "lucide-react"
import { Brain, Code2, FileInput, FileText, Flag, GitBranch, Globe, Link2, Repeat, RotateCw, Terminal, UserCheck, Workflow } from "lucide-react"
import type { CanvasNodeDef } from "@/types/canvas-workflow"

export type CanvasNodeType = CanvasNodeDef["type"]

/** Node types the palette / context menu can create directly. */
export type CreatableNodeType = Exclude<CanvasNodeType, "ai-session">

export interface NodeTypeMeta {
  /** ReactFlow node type string registered in CanvasEditor. */
  rfType: string
  /** Panel header title. */
  title: string
  /** Palette label; undefined keeps the type out of the palette. */
  paletteLabel?: string
  paletteMessageId?: string
  icon: LucideIcon
  /** Icon tint class shared by the node card and the config panel. */
  iconClass: string
  /** Node fill in the minimap. */
  minimapColor: string
  /** Container node: other nodes can be dragged inside it. */
  group?: boolean
  /** Fresh node name + data when created from the palette. */
  create?: () => { name: string; nodeData: CanvasNodeDef["data"] }
}

export const DEFAULT_GROUP_SIZE = { width: 520, height: 300 }

export function isGroupReactFlowType(rfType: string | undefined): boolean {
  return metaForReactFlowType(rfType).group === true
}

/**
 * One table for everything that varies by node type on the client. Adding a
 * node type means one entry here plus a card component and a config panel.
 */
export const NODE_TYPES: Record<CanvasNodeType, NodeTypeMeta> = {
  // Legacy constant-text node: still renders and runs for saved workflows,
  // but Template replaced it in the palette (same thing, can also read variables).
  "input": {
    rfType: "inputNode",
    title: "Text Node (legacy)",
    icon: FileInput,
    iconClass: "text-blue-500",
    minimapColor: "rgb(59 130 246 / 0.5)",
  },
  "ai": {
    rfType: "aiNode",
    title: "AI Node",
    paletteLabel: "AI node",
    paletteMessageId: "canvas.palette.aiNode",
    icon: Brain,
    iconClass: "text-purple-500",
    minimapColor: "rgb(168 85 247 / 0.5)",
    create: () => ({ name: "AI Node", nodeData: { providerId: "claude-code", userPrompt: "" } }),
  },
  "ai-session": {
    rfType: "aiSessionNode",
    title: "AI Session Node",
    icon: Link2,
    iconClass: "text-blue-500",
    minimapColor: "rgb(6 182 212 / 0.5)",
  },
  "shell": {
    rfType: "shellNode",
    title: "Shell Node",
    paletteLabel: "Shell node",
    icon: Terminal,
    iconClass: "text-status-ok",
    minimapColor: "var(--color-status-ok)",
    create: () => ({ name: "Shell", nodeData: { command: "" } }),
  },
  "template": {
    rfType: "templateNode",
    title: "Template Node",
    paletteLabel: "Template node",
    icon: FileText,
    iconClass: "text-muted-foreground",
    minimapColor: "var(--color-muted-foreground)",
    create: () => ({ name: "Template", nodeData: { template: "" } }),
  },
  "code": {
    rfType: "codeNode",
    title: "Code Node",
    paletteLabel: "Code node",
    icon: Code2,
    iconClass: "text-status-info",
    minimapColor: "var(--color-status-info)",
    create: () => ({ name: "Code", nodeData: { language: "javascript", code: "" } }),
  },
  "if": {
    rfType: "ifNode",
    title: "If/Else Node",
    paletteLabel: "If/Else node",
    icon: GitBranch,
    iconClass: "text-status-warn",
    minimapColor: "var(--color-status-warn)",
    create: () => ({ name: "Condition", nodeData: { cases: [{ id: "case1", conditions: [{ variable: "", operator: "is_true" }], combinator: "and" }] } }),
  },
  "http": {
    rfType: "httpNode",
    title: "HTTP Node",
    paletteLabel: "HTTP node",
    icon: Globe,
    iconClass: "text-status-info",
    minimapColor: "var(--color-status-info)",
    create: () => ({
      name: "HTTP",
      nodeData: { method: "GET", url: "", headers: [], bodyType: "none", body: "", auth: { type: "none" } },
    }),
  },
  "iteration": {
    rfType: "iterationNode",
    title: "Iteration",
    paletteLabel: "Iteration node",
    icon: Repeat,
    iconClass: "text-status-warn",
    minimapColor: "var(--color-status-warn)",
    group: true,
    create: () => ({ name: "For each", nodeData: { source: "", sourceMode: "json", concurrency: 4, output: "" } }),
  },
  "loop": {
    rfType: "loopNode",
    title: "Loop",
    paletteLabel: "Loop node",
    icon: RotateCw,
    iconClass: "text-status-warn",
    minimapColor: "var(--color-status-warn)",
    group: true,
    create: () => ({ name: "Loop", nodeData: { until: "", maxIterations: 5, variables: [], output: "" } }),
  },
  "subworkflow": {
    rfType: "subworkflowNode",
    title: "Sub-workflow",
    paletteLabel: "Sub-workflow node",
    icon: Workflow,
    iconClass: "text-purple-500",
    minimapColor: "rgb(168 85 247 / 0.5)",
    create: () => ({ name: "Sub-workflow", nodeData: { workflowId: 0, inputs: [] } }),
  },
  "approval": {
    rfType: "approvalNode",
    title: "Approval",
    paletteLabel: "Approval node",
    icon: UserCheck,
    iconClass: "text-status-warn",
    minimapColor: "var(--color-status-warn)",
    create: () => ({ name: "Approval", nodeData: { message: "" } }),
  },
  "end": {
    rfType: "endNode",
    title: "End Node",
    paletteLabel: "End node",
    icon: Flag,
    iconClass: "text-foreground/70",
    minimapColor: "var(--color-foreground)",
    create: () => ({ name: "End", nodeData: { outputs: [{ key: "result", value: "" }] } }),
  },
}

const RF_TO_BACKEND: Record<string, CanvasNodeType> = Object.fromEntries(
  (Object.entries(NODE_TYPES) as Array<[CanvasNodeType, NodeTypeMeta]>).map(([type, meta]) => [meta.rfType, type])
)

export function toReactFlowNodeType(backendType: CanvasNodeType): string {
  return NODE_TYPES[backendType]?.rfType ?? NODE_TYPES.ai.rfType
}

export function fromReactFlowNodeType(rfType: string): CanvasNodeType {
  return RF_TO_BACKEND[rfType] ?? "ai"
}

export function metaForReactFlowType(rfType: string | undefined): NodeTypeMeta {
  return NODE_TYPES[fromReactFlowNodeType(rfType ?? "")]
}

export const CREATABLE_NODE_TYPES = (Object.keys(NODE_TYPES) as CanvasNodeType[])
  .filter((type): type is CreatableNodeType => NODE_TYPES[type].create !== undefined)
