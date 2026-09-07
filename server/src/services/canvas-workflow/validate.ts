import type {
  CanvasAINodeData,
  CanvasAISessionNodeData,
  CanvasApprovalNodeData,
  CanvasCodeNodeData,
  CanvasEndNodeData,
  CanvasHttpNodeData,
  CanvasIfNodeData,
  CanvasIterationNodeData,
  CanvasLoopNodeData,
  CanvasNode,
  CanvasShellNodeData,
  CanvasSubWorkflowNodeData,
  CanvasTemplateNodeData,
} from '../../types/canvas-workflow.js'
import { compileConditionGroup } from './conditions.js'
import { checkTemplateSyntax } from './template.js'

interface TemplateField {
  label: string
  template: string
  kind: 'template' | 'condition'
}

/** Every template-bearing field of a node, so a typo is caught at save time. */
export function collectTemplateFields(node: CanvasNode): TemplateField[] {
  const fields: TemplateField[] = []
  const add = (label: string, template: string | undefined, kind: TemplateField['kind'] = 'template') => {
    if (typeof template === 'string' && template.trim().length > 0) fields.push({ label, template, kind })
  }

  switch (node.type) {
    case 'ai': add('prompt', (node.data as CanvasAINodeData).userPrompt); break
    case 'ai-session': add('prompt', (node.data as CanvasAISessionNodeData).prompt); break
    case 'shell': add('command', (node.data as CanvasShellNodeData).command); break
    case 'template': add('template', (node.data as CanvasTemplateNodeData).template); break
    case 'code': void (node.data as CanvasCodeNodeData); break
    case 'if': {
      for (const c of (node.data as CanvasIfNodeData).cases ?? []) {
        try {
          add(`case ${c.id}`, compileConditionGroup(c), 'condition')
        } catch (error) {
          fields.push({ label: `case ${c.id}`, template: `__invalid__ ${(error as Error).message}`, kind: 'condition' })
        }
      }
      break
    }
    case 'http': {
      const data = node.data as CanvasHttpNodeData
      add('url', data.url)
      add('body', data.body)
      for (const h of data.headers ?? []) add(`header ${h.key}`, h.value)
      if (data.auth?.type === 'bearer') add('token', data.auth.token)
      if (data.auth?.type === 'basic') { add('username', data.auth.username); add('password', data.auth.password) }
      break
    }
    case 'end': for (const o of (node.data as CanvasEndNodeData).outputs ?? []) add(`output ${o.key}`, o.value); break
    case 'iteration': {
      const data = node.data as CanvasIterationNodeData
      add('items', data.source)
      add('result', data.output)
      break
    }
    case 'loop': {
      const data = node.data as CanvasLoopNodeData
      try {
        add('exit condition', compileConditionGroup({ expression: data.until, conditions: data.untilConditions, combinator: data.untilCombinator }), 'condition')
      } catch (error) {
        fields.push({ label: 'exit condition', template: `__invalid__ ${(error as Error).message}`, kind: 'condition' })
      }
      for (const v of data.variables ?? []) { add(`${v.name} initial`, v.initial); add(`${v.name} next`, v.next) }
      add('output', data.output)
      break
    }
    case 'subworkflow': for (const i of (node.data as CanvasSubWorkflowNodeData).inputs ?? []) add(`variable ${i.key}`, i.value); break
    case 'approval': add('message', (node.data as CanvasApprovalNodeData).message); break
    default: break
  }
  return fields
}

/** Compile every template once; the first syntax error names the node and field. */
export function validateTemplates(nodes: CanvasNode[]): string | null {
  for (const node of nodes) {
    for (const field of collectTemplateFields(node)) {
      if (field.template.startsWith('__invalid__ ')) {
        return `Node "${node.name}" ${field.label}: ${field.template.slice('__invalid__ '.length)}`
      }
      const error = checkTemplateSyntax(field.template, field.kind)
      if (error) return `Node "${node.name}" ${field.label}: ${error}`
    }
  }
  return null
}
