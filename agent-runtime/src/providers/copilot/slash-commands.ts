import type { SlashCommandItem } from '../../types.js'
import type { CopilotSessionEvent } from './types.js'
import type {
  CommandsChangedCommand,
  SkillsLoadedSkill,
} from '@github/copilot-sdk'

export interface CopilotSlashCommandState {
  skills: SlashCommandItem[]
  commands: SlashCommandItem[]
  receivedSkills: boolean
  receivedCommands: boolean
}

export function createCopilotSlashCommandState(): CopilotSlashCommandState {
  return {
    skills: [],
    commands: [],
    receivedSkills: false,
    receivedCommands: false,
  }
}

export function captureCopilotSlashCommands(
  state: CopilotSlashCommandState,
  event: CopilotSessionEvent,
): boolean {
  if (event.type === 'session.skills_loaded') {
    state.skills = event.data.skills
      .filter((skill: SkillsLoadedSkill) => skill.userInvocable && skill.enabled)
      .map((skill: SkillsLoadedSkill) => ({
        name: skill.name,
        description: skill.description ?? '',
        type: 'skill' as const,
      }))
    state.receivedSkills = true
    return true
  }

  if (event.type === 'commands.changed') {
    state.commands = event.data.commands.map((command: CommandsChangedCommand) => ({
      name: command.name,
      description: command.description ?? '',
      type: 'command' as const,
    }))
    state.receivedCommands = true
    return true
  }

  return false
}

export function hasCompleteCopilotSlashCommandState(state: CopilotSlashCommandState): boolean {
  return state.receivedSkills && state.receivedCommands
}

export function getCopilotSlashCommands(state: CopilotSlashCommandState): SlashCommandItem[] {
  const seen = new Set<string>()
  const result: SlashCommandItem[] = []
  for (const item of [...state.skills, ...state.commands]) {
    if (!item.name || seen.has(item.name)) continue
    seen.add(item.name)
    result.push(item)
  }
  return result
}
