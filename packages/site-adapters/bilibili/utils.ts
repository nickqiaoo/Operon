/**
 * Bilibili shared helpers — ported from OpenCLI `clis/bilibili/utils.js`.
 * WBI signing + authenticated page-context fetch.
 */

import { createHash } from "node:crypto"
import type { AdapterPage } from "../types.ts"

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

export function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").trim()
}

export function payloadData(payload: unknown): Record<string, unknown> | undefined {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const data = (payload as Record<string, unknown>).data
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>
    }
  }
  return undefined
}

export async function fetchJson(page: AdapterPage, url: string): Promise<unknown> {
  const urlJs = JSON.stringify(url)
  return page.evaluate(`
    async () => {
      const res = await fetch(${urlJs}, { credentials: "include" });
      return await res.json();
    }
  `)
}

async function getNavData(page: AdapterPage): Promise<unknown> {
  return page.evaluate(`
    async () => {
      const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
      return await res.json();
    }
  `)
}

async function getWbiKeys(page: AdapterPage): Promise<{ imgKey: string; subKey: string }> {
  const nav = (await getNavData(page)) as {
    data?: { wbi_img?: { img_url?: string; sub_url?: string } }
  }
  const wbiImg = nav?.data?.wbi_img ?? {}
  const imgUrl = wbiImg.img_url ?? ""
  const subUrl = wbiImg.sub_url ?? ""
  const imgKey = imgUrl.split("/").pop()?.split(".")[0] ?? ""
  const subKey = subUrl.split("/").pop()?.split(".")[0] ?? ""
  return { imgKey, subKey }
}

function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] || "").join("").slice(0, 32)
}

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex")
}

export async function wbiSign(
  page: AdapterPage,
  params: Record<string, unknown>,
): Promise<Record<string, string>> {
  const { imgKey, subKey } = await getWbiKeys(page)
  const mixinKey = getMixinKey(imgKey, subKey)
  const wts = Math.floor(Date.now() / 1000)
  const sorted: Record<string, string> = {}
  const allParams: Record<string, unknown> = { ...params, wts: String(wts) }
  for (const key of Object.keys(allParams).sort()) {
    sorted[key] = String(allParams[key]).replace(/[!'()*]/g, "")
  }
  const query = new URLSearchParams(sorted).toString().replace(/\+/g, "%20")
  sorted.w_rid = md5(query + mixinKey)
  return sorted
}

export async function apiGet(
  page: AdapterPage,
  path: string,
  opts: { params?: Record<string, unknown>; signed?: boolean } = {},
): Promise<unknown> {
  const baseUrl = "https://api.bilibili.com"
  let params = opts.params ?? {}
  if (opts.signed) {
    params = await wbiSign(page, params)
  }
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  )
    .toString()
    .replace(/\+/g, "%20")
  const url = `${baseUrl}${path}?${qs}`
  return fetchJson(page, url)
}

export async function getSelfUid(page: AdapterPage): Promise<string> {
  const nav = (await getNavData(page)) as { data?: { mid?: number | string } }
  const mid = nav?.data?.mid
  if (mid == null) {
    throw new Error("bilibili: not logged in (open bilibili.com in Chrome and sign in)")
  }
  return String(mid)
}

export async function resolveUid(page: AdapterPage, input: string): Promise<string> {
  if (/^\d+$/.test(input)) return input
  const payload = (await apiGet(page, "/x/web-interface/wbi/search/type", {
    params: { search_type: "bili_user", keyword: input },
    signed: true,
  })) as { data?: { result?: Array<{ mid?: number | string }> } }
  const results = payload?.data?.result
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`bilibili: user not found for ${input}`)
  }
  const mid = String(results[0]?.mid ?? "").trim()
  if (!mid) throw new Error(`bilibili: malformed mid for ${input}`)
  return mid
}

export async function resolveBvid(input: string): Promise<string> {
  const trimmed = String(input).trim()
  if (/^BV[A-Za-z0-9]+$/i.test(trimmed)) return trimmed
  try {
    const parsed = new URL(trimmed)
    if (/(\.|^)bilibili\.com$/i.test(parsed.hostname)) {
      const match = parsed.pathname.match(/\/(?:video|bangumi\/play)\/(BV[A-Za-z0-9]+)/i)
      if (match?.[1]) return match[1]
    }
  } catch {
    // fall through
  }
  const shortCode = trimmed
    .replace(/^https?:\/\//, "")
    .replace(/^(www\.)?b23\.tv\//, "")
  if (!/^[A-Za-z0-9]+$/.test(shortCode)) {
    throw new Error(`Cannot resolve BV ID from: ${trimmed}`)
  }
  const res = await fetch(`https://b23.tv/${shortCode}`, { redirect: "manual" })
  const location = res.headers.get("location") ?? ""
  const match = location.match(/\/video\/(BV[A-Za-z0-9]+)/)
  if (!match?.[1]) throw new Error(`Cannot resolve BV ID from short URL: ${trimmed}`)
  return match[1]
}
