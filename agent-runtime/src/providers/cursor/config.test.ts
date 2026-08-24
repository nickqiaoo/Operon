import type * as acp from '@zed-industries/agent-client-protocol'
import { describe, expect, it } from 'vitest'
import { toSlashCommands } from '../acp/commands.js'
import { CURSOR_CONFIG } from './config.js'

const cmd = (name: string, description: string): acp.AvailableCommand =>
  ({ name, description }) as acp.AvailableCommand

describe('CURSOR_CONFIG.classifyCommand', () => {
  // Real samples from cursor-agent's available_commands_update (probe dump).
  it('tags entries whose description ends in "(… skill)" as skills', () => {
    for (const desc of [
      'and fixing CI in a loop. (builtin skill)',
      'Generate Playwright e2e test code. (project skill)',
      'Control the Operon in-app Browser. (user skill)',
    ]) {
      expect(CURSOR_CONFIG.classifyCommand?.(cmd('x', desc))).toBe('skill')
    }
  })

  it('leaves builtin commands and user prompts as plain commands', () => {
    for (const desc of [
      'Copy the last request ID to clipboard', // no marker
      'Find low-info comments … (global)', // user prompt
      '--- (user)', // user command
    ]) {
      expect(CURSOR_CONFIG.classifyCommand?.(cmd('x', desc))).toBe('command')
    }
  })

  it('flows through toSlashCommands with the right per-entry type', () => {
    const items = toSlashCommands(CURSOR_CONFIG, [
      cmd('babysit', 'Keep a PR merge-ready … (builtin skill)'),
      cmd('commit', '--- (user)'),
      cmd('simplify', 'Find low-info comments … (global)'),
    ])
    expect(items).toEqual([
      { name: 'babysit', description: 'Keep a PR merge-ready … (builtin skill)', type: 'skill' },
      { name: 'commit', description: '--- (user)', type: 'command' },
      { name: 'simplify', description: 'Find low-info comments … (global)', type: 'command' },
    ])
  })
})

describe('CURSOR_CONFIG command discovery', () => {
  it('waits for available_commands_update during the background session probe', () => {
    expect(CURSOR_CONFIG.probeCommands).toBe(true)
  })
})
