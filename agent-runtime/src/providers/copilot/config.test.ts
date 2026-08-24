import { describe, expect, it } from 'vitest'
import { copilotAgentMode, copilotModeAsksApproval, resolveReasoningEffort } from './config.js'

describe('copilotAgentMode', () => {
  it('maps the three picker modes to SDK agentModes', () => {
    expect(copilotAgentMode('interactive')).toBe('interactive')
    expect(copilotAgentMode('plan')).toBe('plan')
    expect(copilotAgentMode('autopilot')).toBe('autopilot')
  })

  it('folds legacy ids: default→autopilot, readOnly→interactive, undefined→autopilot', () => {
    expect(copilotAgentMode('default')).toBe('autopilot')
    expect(copilotAgentMode('readOnly')).toBe('interactive')
    expect(copilotAgentMode(undefined)).toBe('autopilot')
    expect(copilotAgentMode('something-else')).toBe('autopilot')
  })
})

describe('copilotModeAsksApproval', () => {
  it('only Normal (interactive) and legacy readOnly surface approval cards', () => {
    expect(copilotModeAsksApproval('interactive')).toBe(true)
    expect(copilotModeAsksApproval('readOnly')).toBe(true)
    expect(copilotModeAsksApproval('autopilot')).toBe(false)
    expect(copilotModeAsksApproval('plan')).toBe(false)
    expect(copilotModeAsksApproval(undefined)).toBe(false)
  })
})

describe('resolveReasoningEffort', () => {
  it('accepts the four SDK levels', () => {
    expect(resolveReasoningEffort('low')).toBe('low')
    expect(resolveReasoningEffort('medium')).toBe('medium')
    expect(resolveReasoningEffort('high')).toBe('high')
    expect(resolveReasoningEffort('xhigh')).toBe('xhigh')
  })

  it("returns undefined for unset, unknown, or claude-only 'max'", () => {
    expect(resolveReasoningEffort('max')).toBeUndefined()
    expect(resolveReasoningEffort(undefined)).toBeUndefined()
    expect(resolveReasoningEffort('')).toBeUndefined()
    expect(resolveReasoningEffort('ultra')).toBeUndefined()
  })
})
