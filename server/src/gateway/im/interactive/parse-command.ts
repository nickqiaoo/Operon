export interface ParsedCommand {
  isCommand: boolean
  commandName?: string
  commandArgs?: string
}

/**
 * Parse a "/name args..." style command. Strips an optional `@botname` suffix
 * (Telegram convention) so `/help@mybot` becomes `help`.
 */
export function parseCommand(rawText: string): ParsedCommand {
  const text = rawText.trimStart()
  if (!text.startsWith('/')) return { isCommand: false }

  const spaceIdx = text.indexOf(' ')
  let commandName: string
  let commandArgs: string | undefined
  if (spaceIdx < 0) {
    commandName = text.slice(1)
  } else {
    commandName = text.slice(1, spaceIdx)
    commandArgs = text.slice(spaceIdx + 1)
  }

  const atIdx = commandName.indexOf('@')
  if (atIdx >= 0) commandName = commandName.slice(0, atIdx)

  if (!commandName) return { isCommand: false }
  return { isCommand: true, commandName, commandArgs }
}
