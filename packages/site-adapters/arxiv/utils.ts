export const ARXIV_BASE = "https://export.arxiv.org/api/query"
const ARXIV_CATEGORY_PATTERN =
  /^[a-z]+(?:-[a-z]+)*(?:\.[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)?$/

export async function arxivFetch(params: string): Promise<string> {
  const resp = await fetch(`${ARXIV_BASE}?${params}`)
  if (!resp.ok) throw new Error(`arxiv: HTTP ${resp.status}`)
  return resp.text()
}

export function normalizeArxivLimit(
  value: unknown,
  defaultValue: number,
  maxValue: number,
): number {
  const limit = Number(value ?? defaultValue)
  if (!Number.isInteger(limit) || limit <= 0 || limit > maxValue) {
    throw new Error(`arxiv: limit must be 1..${maxValue}`)
  }
  return limit
}

export function normalizeArxivCategory(value: unknown): string {
  const category = String(value || "").trim()
  if (!ARXIV_CATEGORY_PATTERN.test(category)) {
    throw new Error(`arxiv: invalid category "${value}" (e.g. cs.CL, cs.LG)`)
  }
  return category
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
}

function extract(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))
  return m ? m[1]!.trim() : ""
}

function extractAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g")
  const results: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) results.push(m[1]!.trim())
  return results
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*?\\b${attr}="([^"]*)"`))
  return m ? m[1]! : ""
}

function extractAllAttr(xml: string, tag: string, attr: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*?\\b${attr}="([^"]*)"`, "g")
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1]!)
  return out
}

function findLinkHref(xml: string, rel: string): string {
  const re = /<link\b([^>]*)\/?>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1]!
    if (new RegExp(`\\brel="${rel}"`).test(attrs)) {
      const h = attrs.match(/\bhref="([^"]*)"/)
      if (h) return h[1]!
    }
  }
  return ""
}

export function parseEntries(xml: string) {
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g
  const entries: Array<Record<string, string>> = []
  let m: RegExpExecArray | null
  while ((m = entryRe.exec(xml)) !== null) {
    const e = m[1]!
    const rawId = extract(e, "id")
    const arxivId = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "")
    const pdf = findLinkHref(e, "related") || `https://arxiv.org/pdf/${arxivId}`
    entries.push({
      id: arxivId,
      title: decodeEntities(extract(e, "title").replace(/\s+/g, " ")),
      authors: decodeEntities(extractAll(e, "name").join(", ")),
      abstract: decodeEntities(extract(e, "summary").replace(/\s+/g, " ")),
      published: extract(e, "published").slice(0, 10),
      updated: extract(e, "updated").slice(0, 10),
      primary_category: extractAttr(e, "arxiv:primary_category", "term"),
      categories: extractAllAttr(e, "category", "term").join(", "),
      comment: decodeEntities(extract(e, "arxiv:comment").replace(/\s+/g, " ")),
      pdf,
      url: `https://arxiv.org/abs/${arxivId}`,
    })
  }
  return entries
}
