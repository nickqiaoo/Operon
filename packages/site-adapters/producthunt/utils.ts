export const PRODUCTHUNT_CATEGORY_SLUGS = [
  "ai-agents",
  "ai-coding-agents",
  "ai-code-editors",
  "ai-chatbots",
  "ai-workflow-automation",
  "vibe-coding",
  "developer-tools",
  "productivity",
  "design-creative",
  "marketing-sales",
  "no-code-platforms",
  "llms",
  "finance",
  "social-community",
  "engineering-development",
]

const UA = "Mozilla/5.0 (compatible; operon-site-adapters/1.0)"

export async function fetchFeed(category?: string) {
  const url = category
    ? `https://www.producthunt.com/feed?category=${encodeURIComponent(category)}`
    : "https://www.producthunt.com/feed"
  const resp = await fetch(url, { headers: { "User-Agent": UA } })
  if (!resp.ok) return [] as Array<Record<string, string>>
  return parseFeed(await resp.text())
}

export function parseFeed(xml: string) {
  const posts: Array<Record<string, string | number>> = []
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let match: RegExpExecArray | null
  let rank = 1
  while ((match = entryRegex.exec(xml))) {
    const block = match[1]!
    const name = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? ""
    const author = block.match(/<name>([\s\S]*?)<\/name>/)?.[1]?.trim() ?? ""
    const pubRaw = block.match(/<published>(.*?)<\/published>/)?.[1]?.trim() ?? ""
    const date = pubRaw.slice(0, 10)
    const link = block.match(/<link[^>]*href="([^"]+)"/)?.[1]?.trim() ?? ""
    const contentRaw = block.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? ""
    const contentDecoded = contentRaw
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
    const tagline =
      contentDecoded.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1]?.replace(/<[^>]+>/g, "").trim()
      ?? ""
    posts.push({
      rank: rank++,
      name,
      tagline,
      author,
      date,
      url: link,
    })
  }
  return posts
}
