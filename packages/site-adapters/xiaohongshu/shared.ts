/**
 * Small helpers shared by the Xiaohongshu commands (OpenCLI clis/xiaohongshu).
 */

import { CommandExecutionError } from "../errors.ts"
import type { AdapterPage } from "../types.ts"

export const XHS_WEB_HOST = "www.xiaohongshu.com"

export type Row = Record<string, unknown>

export function isRecord(value: unknown): value is Row {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

export function toCleanString(value: unknown): string {
  if (typeof value === "string") return value.trim()
  return value == null ? "" : String(value).trim()
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** func adapters receive `page: null` only for browser:false commands. */
export function requirePage(page: AdapterPage | null, command: string): AdapterPage {
  if (!page) throw new CommandExecutionError(`Browser session required for ${command}`)
  return page
}

export function isXiaohongshuHost(hostname: unknown): boolean {
  const host = String(hostname || "").toLowerCase()
  return host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com")
}
