import { describe, expect, it } from 'vitest'
import { isOperonWorkflowTool, isWorkflowToolName } from './workflowToolName'

describe('isWorkflowToolName', () => {
  it.each([
    'Workflow',
    'OperonWorkflow',
    'tool-OperonWorkflow',
    'workflow__OperonWorkflow',
    'mcp__workflow__OperonWorkflow',
    // Pre-rename name, still in old transcripts.
    'RunWorkflow',
    'mcp__workflow__RunWorkflow',
  ])('recognizes %s', (name) => {
    expect(isWorkflowToolName(name)).toBe(true)
  })

  it('does not match unrelated tools', () => {
    expect(isWorkflowToolName('CreateWorkflow')).toBe(false)
  })
})

describe('isOperonWorkflowTool', () => {
  it.each([
    'OperonWorkflow',
    'tool-OperonWorkflow',
    'workflow__OperonWorkflow',
    'mcp__workflow__OperonWorkflow',
  ])('claims %s', (name) => {
    expect(isOperonWorkflowTool(name)).toBe(true)
  })

  // Runs made before the rename are still ours. Forgetting the old name would
  // relabel every historical card as the host agent's own tool.
  it.each(['RunWorkflow', 'tool-RunWorkflow', 'mcp__workflow__RunWorkflow'])(
    'still claims the pre-rename %s',
    (name) => {
      expect(isOperonWorkflowTool(name)).toBe(true)
    },
  )

  // The host agent's own tool renders as a workflow card too, but it is not ours:
  // it has no runId here and never reaches the panel.
  it.each(['Workflow', 'tool-Workflow', 'local_workflow'])('disclaims %s', (name) => {
    expect(isOperonWorkflowTool(name)).toBe(false)
  })
})
