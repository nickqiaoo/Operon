export const EXTRACT_MAX_LEN = 300
export const DESC_MAX_LEN = 80

const UA = "operon-site-adapters/1.0 (https://github.com/operon)"

export async function wikiFetch(lang: string, path: string): Promise<unknown> {
  const url = `https://${lang}.wikipedia.org${path}`
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  })
  if (!resp.ok) throw new Error(`wikipedia: HTTP ${resp.status} for ${path}`)
  return resp.json()
}

export function formatSummaryRow(data: Record<string, unknown>, lang: string) {
  const contentUrls = data.content_urls as { desktop?: { page?: string } } | undefined
  return {
    title: data.title,
    description: data.description ?? "-",
    extract: String(data.extract ?? "").slice(0, EXTRACT_MAX_LEN),
    url: contentUrls?.desktop?.page ?? `https://${lang}.wikipedia.org`,
  }
}
