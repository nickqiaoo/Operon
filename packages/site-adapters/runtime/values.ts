import { CommandExecutionError } from "../errors.ts"
import type { AdapterPage } from "../types.ts"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

export function toCleanString(value: unknown): string {
  if (typeof value === "string") return value.trim()
  return value == null ? "" : String(value).trim()
}

/** APIs may return a list, a data envelope, or a single record. */
export function requireRows(value: unknown, command: string): Record<string, unknown>[] {
  const source = isRecord(value) && Array.isArray(value.data) ? value.data : value
  const rows = Array.isArray(source) ? source : isRecord(source) ? [source] : null
  if (!rows || !rows.every(isRecord)) {
    throw new CommandExecutionError(`${command}: unexpected response`)
  }
  return rows
}

/** func adapters receive page:null only for browser:false commands. */
export function requirePage(page: AdapterPage | null, command: string): AdapterPage {
  if (!page) throw new CommandExecutionError(`Browser session required for ${command}`)
  return page
}
