import type * as acp from '@zed-industries/agent-client-protocol'
import type { SlashCommandItem } from '../../types.js'
import type { AcpProviderConfig } from './types.js'

/**
 * ACP's `available_commands_update` entries → the descriptor's slash-command
 * shape. `name`/`description` are protocol fields, so the mapping and de-dupe
 * live here; the skill/command split has no protocol backing and is delegated
 * to the provider's `classifyCommand` (see its doc in ./types.ts).
 *
 * Shared because both discovery (pre-session probe) and a live session capture
 * the same push and must classify it identically.
 */
export function toSlashCommands(
  config: AcpProviderConfig,
  commands: acp.AvailableCommand[] | null | undefined,
): SlashCommandItem[] {
  if (!commands) return []
  const seen = new Set<string>()
  const items: SlashCommandItem[] = []
  for (const command of commands) {
    const name = command.name?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    items.push({
      name,
      description: command.description ?? '',
      type: config.classifyCommand?.(command) ?? 'command',
    })
  }
  return items
}
