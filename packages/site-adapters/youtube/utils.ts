/** Extract a YouTube video ID from URL or bare id. */
export function parseVideoId(input: unknown): string {
  const raw = String(input ?? "").trim()
  if (!raw.startsWith("http")) return raw
  try {
    const parsed = new URL(raw)
    if (parsed.searchParams.has("v")) return parsed.searchParams.get("v")!
    if (parsed.hostname === "youtu.be") return parsed.pathname.slice(1).split("/")[0]!
    const pathMatch = parsed.pathname.match(/^\/(shorts|embed|live|v)\/([^/?]+)/)
    if (pathMatch) return pathMatch[2]!
  } catch {
    // fall through
  }
  return raw
}
