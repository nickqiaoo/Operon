import type { ArgDef } from "../types.ts"

/**
 * Validate/coerce invoke options against ArgDef list.
 * `browser` is handled separately by defineCommand.
 */
export function resolveArgs(
  defs: ArgDef[] | undefined,
  options: Record<string, unknown>,
  commandId: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const def of defs ?? []) {
    let value = options[def.name]
    if (value === undefined) value = def.default
    if ((value === undefined || value === null) && def.required) {
      throw new Error(`${commandId}: missing required arg "${def.name}"`)
    }
    if (value === undefined) continue

    if (def.choices && !def.choices.includes(String(value))) {
      throw new Error(
        `${commandId}: arg "${def.name}" must be one of ${def.choices.join(", ")}, got ${JSON.stringify(value)}`,
      )
    }

    if (def.type === "int") {
      const n = typeof value === "number" ? value : Number(value)
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new Error(`${commandId}: arg "${def.name}" must be an integer, got ${JSON.stringify(value)}`)
      }
      out[def.name] = n
      continue
    }
    if (def.type === "bool") {
      if (typeof value === "boolean") out[def.name] = value
      else if (value === "true" || value === 1) out[def.name] = true
      else if (value === "false" || value === 0) out[def.name] = false
      else throw new Error(`${commandId}: arg "${def.name}" must be a boolean`)
      continue
    }
    out[def.name] = value
  }
  return out
}
