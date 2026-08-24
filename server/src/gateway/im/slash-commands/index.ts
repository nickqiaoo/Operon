import { SlashCommandRegistry } from './registry.js'
import type { SlashCommandDeps } from './types.js'
import { stopCommand } from './handlers/stop.js'
import { resetCommand } from './handlers/reset.js'
import { modelCommand } from './handlers/model.js'
import { modeCommand } from './handlers/mode.js'
import {
  continueCommand,
  helpCommand,
  newCommand,
  startCommand,
  statusCommand,
} from './handlers/interactive-only.js'

export { SlashCommandRegistry } from './registry.js'
export type {
  InteractiveCommandContext,
  MateCommandContext,
  MateHooks,
  SlashCommand,
  SlashCommandContext,
  SlashCommandDeps,
  SlashCommandMode,
} from './types.js'

export function buildSlashCommandRegistry(deps: SlashCommandDeps): SlashCommandRegistry {
  const registry = new SlashCommandRegistry(deps)

  // Shared across mate + interactive
  registry.register(stopCommand)
  registry.register(modelCommand)
  registry.register(modeCommand)

  // Mate-only
  registry.register(resetCommand)

  // Interactive-only
  registry.register(startCommand)
  registry.register(helpCommand)
  registry.register(newCommand)
  registry.register(continueCommand)
  registry.register(statusCommand)

  return registry
}
