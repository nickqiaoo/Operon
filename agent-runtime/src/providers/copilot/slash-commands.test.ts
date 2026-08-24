import { describe, expect, it } from 'vitest'
import {
  captureCopilotSlashCommands,
  createCopilotSlashCommandState,
  getCopilotSlashCommands,
  hasCompleteCopilotSlashCommandState,
} from './slash-commands.js'
import type { CopilotSessionEvent } from './types.js'

const event = (value: object): CopilotSessionEvent => value as CopilotSessionEvent

describe('Copilot slash command discovery', () => {
  it('collects enabled user-invocable skills and SDK commands', () => {
    const state = createCopilotSlashCommandState()

    captureCopilotSlashCommands(state, event({
      type: 'session.skills_loaded',
      data: {
        skills: [
          { name: 'review', description: 'Review changes', enabled: true, userInvocable: true },
          { name: 'hidden', description: 'Internal', enabled: true, userInvocable: false },
          { name: 'disabled', description: 'Disabled', enabled: false, userInvocable: true },
        ],
      },
    }))
    captureCopilotSlashCommands(state, event({
      type: 'commands.changed',
      data: {
        commands: [
          { name: 'compact', description: 'Compact history' },
          { name: 'review', description: 'Duplicate command' },
        ],
      },
    }))

    expect(hasCompleteCopilotSlashCommandState(state)).toBe(true)
    expect(getCopilotSlashCommands(state)).toEqual([
      { name: 'review', description: 'Review changes', type: 'skill' },
      { name: 'compact', description: 'Compact history', type: 'command' },
    ])
  })

  it('replaces each event slice with the latest full snapshot', () => {
    const state = createCopilotSlashCommandState()
    captureCopilotSlashCommands(state, event({
      type: 'commands.changed',
      data: { commands: [{ name: 'old', description: '' }] },
    }))
    captureCopilotSlashCommands(state, event({
      type: 'commands.changed',
      data: { commands: [{ name: 'new', description: '' }] },
    }))

    expect(getCopilotSlashCommands(state)).toEqual([
      { name: 'new', description: '', type: 'command' },
    ])
  })
})
