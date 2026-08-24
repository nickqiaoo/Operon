import { parseCommand } from '../interactive/parse-command.js'
import type {
  SlashCommand,
  SlashCommandContext,
  SlashCommandDeps,
  SlashCommandMode,
} from './types.js'

/**
 * Shared slash-command registry for IM bridge modes (mate + interactive).
 *
 * A command can target one or both modes. Registering the same `(name, mode)`
 * pair twice throws — use one registration with `modes: ['mate', 'interactive']`
 * plus a ctx.mode narrowing inside the handler if the logic overlaps.
 */
export class SlashCommandRegistry {
  private readonly byKey = new Map<string, SlashCommand>()

  constructor(private readonly deps: SlashCommandDeps) {}

  register(cmd: SlashCommand): void {
    if (cmd.modes.length === 0) {
      throw new Error(`[SlashCommandRegistry] command ${cmd.name} has no modes`)
    }
    for (const mode of cmd.modes) {
      const key = this.key(cmd.name, mode)
      if (this.byKey.has(key)) {
        throw new Error(`[SlashCommandRegistry] duplicate command ${cmd.name} for mode ${mode}`)
      }
      this.byKey.set(key, cmd)
    }
  }

  get(name: string, mode: SlashCommandMode): SlashCommand | undefined {
    return this.byKey.get(this.key(name, mode))
  }

  listForMode(mode: SlashCommandMode): SlashCommand[] {
    const seen = new Set<string>()
    const out: SlashCommand[] = []
    for (const cmd of this.byKey.values()) {
      if (!cmd.modes.includes(mode)) continue
      if (seen.has(cmd.name)) continue
      seen.add(cmd.name)
      out.push(cmd)
    }
    return out
  }

  /**
   * Parse `rawText`, look up the command for `mode`, and invoke its handler.
   * Returns `handled=true` only when a command matched AND ran. Callers use
   * `handled=false` to fall back to default message handling.
   */
  async dispatch(
    mode: SlashCommandMode,
    rawText: string,
    buildCtx: (commandName: string, args: string | undefined) => SlashCommandContext | null,
  ): Promise<{ handled: boolean }> {
    const parsed = parseCommand(rawText)
    if (!parsed.isCommand || !parsed.commandName) return { handled: false }

    const cmd = this.get(parsed.commandName, mode)
    if (!cmd) return { handled: false }

    const ctx = buildCtx(parsed.commandName, parsed.commandArgs)
    if (!ctx) return { handled: false }

    await cmd.handler(ctx, this.deps)
    return { handled: true }
  }

  private key(name: string, mode: SlashCommandMode): string {
    return `${mode}:${name}`
  }
}
