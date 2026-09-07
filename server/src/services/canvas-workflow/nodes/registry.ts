import type { CanvasNodeType } from '../../../types/canvas-workflow.js'
import type { NodeExecutorDefinition } from '../types.js'
import { inputNode } from './input.js'
import { aiNode, aiSessionNode } from './ai.js'
import { shellNode } from './shell.js'
import { templateNode } from './template.js'
import { codeNode } from './code.js'
import { ifNode } from './if.js'
import { httpNode } from './http.js'
import { endNode } from './end.js'
import { iterationNode } from './iteration.js'
import { loopNode } from './loop.js'
import { subWorkflowNode } from './subworkflow.js'
import { approvalNode } from './approval.js'

const registry: Record<CanvasNodeType, NodeExecutorDefinition> = {
  'input': inputNode,
  'ai': aiNode,
  'ai-session': aiSessionNode,
  'shell': shellNode,
  'template': templateNode,
  'code': codeNode,
  'if': ifNode,
  'http': httpNode,
  'end': endNode,
  'iteration': iterationNode,
  'loop': loopNode,
  'subworkflow': subWorkflowNode,
  'approval': approvalNode,
}

export function getNodeExecutor(type: CanvasNodeType): NodeExecutorDefinition {
  const definition = registry[type]
  if (!definition) throw new Error(`Unknown node type: ${type as string}`)
  return definition
}
