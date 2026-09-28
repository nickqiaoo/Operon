/**
 * Small helpers shared by the Xiaohongshu commands (OpenCLI clis/xiaohongshu).
 */


export const XHS_WEB_HOST = "www.xiaohongshu.com"

export type Row = Record<string, unknown>

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isXiaohongshuHost(hostname: unknown): boolean {
  const host = String(hostname || "").toLowerCase()
  return host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com")
}
