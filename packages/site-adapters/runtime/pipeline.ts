/**
 * Pipeline-lite: OpenCLI-compatible steps used by declarative web adapters.
 * Supported: navigate, evaluate, fetch, map, filter, limit, sort, select.
 */

import type { AdapterPage } from "./page.ts"
import { hostFetchJson } from "./page.ts"
import { evalExpr, render } from "./template.ts"
import type { PipelineStep } from "../types.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function run(): Promise<void> {
    while (next < items.length) {
      const i = next
      next += 1
      results[i] = await worker(items[i]!, i)
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1))
  await Promise.all(Array.from({ length: n }, () => run()))
  return results
}

async function stepNavigate(
  page: AdapterPage | null,
  params: unknown,
  data: unknown,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!page) throw new Error("navigate requires a browser session")
  if (isRecord(params) && "url" in params) {
    await page.goto(String(render(params.url, { args, data })))
  } else {
    await page.goto(String(render(params, { args, data })))
  }
  return data
}

async function stepEvaluate(
  page: AdapterPage | null,
  params: unknown,
  data: unknown,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!page) throw new Error("evaluate requires a browser session")
  const js = String(render(params, { args, data }))
  let result: unknown = await page.evaluate(js)
  if (typeof result === "string") {
    const trimmed = result.trim()
    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
      || (trimmed.startsWith("{") && trimmed.endsWith("}"))
    ) {
      try {
        result = JSON.parse(trimmed)
      } catch {
        // keep string
      }
    }
  }
  return result
}

async function fetchSingle(
  page: AdapterPage | null,
  url: string,
  method: string,
  headers: Record<string, string>,
): Promise<unknown> {
  if (page) return page.fetchJson(url, { method, headers })
  return hostFetchJson(url, { method, headers })
}

async function stepFetch(
  page: AdapterPage | null,
  params: unknown,
  data: unknown,
  args: Record<string, unknown>,
): Promise<unknown> {
  const paramObject = isRecord(params) ? params : {}
  const urlOrObj = typeof params === "string" ? params : (paramObject.url ?? "")
  const method = typeof paramObject.method === "string" ? paramObject.method : "GET"
  const queryParams = isRecord(paramObject.params) ? paramObject.params : {}
  const headersIn = isRecord(paramObject.headers) ? paramObject.headers : {}
  const urlTemplate = String(urlOrObj)

  const renderQuery = (ctx: { args: Record<string, unknown>; data: unknown; item?: unknown; index?: number }) => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(queryParams)) {
      out[k] = String(render(v, ctx))
    }
    return out
  }
  const renderHeaders = (ctx: { args: Record<string, unknown>; data: unknown }) => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(headersIn)) {
      out[k] = String(render(v, ctx))
    }
    return out
  }

  const withQuery = (url: string, q: Record<string, string>) => {
    if (Object.keys(q).length === 0) return url
    const qs = new URLSearchParams(q).toString()
    return `${url}${url.includes("?") ? "&" : "?"}${qs}`
  }

  // Per-item fetch when data is an array and the URL references item
  if (Array.isArray(data) && urlTemplate.includes("item")) {
    const concurrency = typeof paramObject.concurrency === "number" ? paramObject.concurrency : 5
    const headers = renderHeaders({ args, data })
    return mapConcurrent(data, concurrency, async (item, index) => {
      const url = withQuery(
        String(render(urlTemplate, { args, data, item, index })),
        renderQuery({ args, data, item, index }),
      )
      try {
        return await fetchSingle(page, url, method.toUpperCase(), headers)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  const url = withQuery(
    String(render(urlOrObj, { args, data })),
    renderQuery({ args, data }),
  )
  return fetchSingle(page, url, method.toUpperCase(), renderHeaders({ args, data }))
}

async function stepSelect(
  _page: AdapterPage | null,
  params: unknown,
  data: unknown,
  args: Record<string, unknown>,
): Promise<unknown> {
  const pathStr = String(render(params, { args, data }))
  if (data && typeof data === "object") {
    let current: unknown = data
    for (const part of pathStr.split(".")) {
      if (isRecord(current)) current = current[part]
      else if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)]
      else return null
    }
    return current
  }
  return data
}

async function stepMap(
  _page: AdapterPage | null,
  params: unknown,
  data: unknown,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (data == null || typeof data !== "object") return data
  let source: unknown = data
  if (isRecord(params) && "select" in params) {
    source = await stepSelect(null, params.select, data, args)
  }
  if (source == null || typeof source !== "object") return source

  let items: unknown[] = Array.isArray(source) ? source : [source]
  if (isRecord(source) && Array.isArray(source.data)) items = source.data

  const templateParams = isRecord(params) ? params : {}
  const result: Array<Record<string, unknown>> = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const row: Record<string, unknown> = {}
    for (const [key, template] of Object.entries(templateParams)) {
      if (key === "select") continue
      row[key] = render(template, { args, data: source, root: data, item, index: i })
    }
    result.push(row)
  }
  return result
}

async function stepFilter(
  _page: AdapterPage | null,
  params: unknown,
  data: unknown,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!Array.isArray(data)) return data
  return data.filter((item, i) => Boolean(evalExpr(String(params), { args, item, index: i })))
}

async function stepSort(
  _page: AdapterPage | null,
  params: unknown,
  data: unknown,
): Promise<unknown> {
  if (!Array.isArray(data)) return data
  const key = isRecord(params) ? String(params.by ?? "") : String(params)
  const reverse = isRecord(params) ? params.order === "desc" : false
  return [...data].sort((a, b) => {
    const left = isRecord(a) ? a[key] : undefined
    const right = isRecord(b) ? b[key] : undefined
    const cmp = String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true })
    return reverse ? -cmp : cmp
  })
}

async function stepLimit(
  _page: AdapterPage | null,
  params: unknown,
  data: unknown,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!Array.isArray(data)) return data
  return data.slice(0, Number(render(params, { args, data })))
}

type StepHandler = (
  page: AdapterPage | null,
  params: unknown,
  data: unknown,
  args: Record<string, unknown>,
) => Promise<unknown>

const HANDLERS: Record<string, StepHandler> = {
  navigate: stepNavigate,
  evaluate: stepEvaluate,
  fetch: stepFetch,
  map: stepMap,
  filter: stepFilter,
  sort: stepSort,
  limit: stepLimit,
  select: stepSelect,
}

export async function executePipeline(
  page: AdapterPage | null,
  pipeline: PipelineStep[],
  args: Record<string, unknown> = {},
): Promise<unknown> {
  let data: unknown = null
  for (let i = 0; i < pipeline.length; i++) {
    const step = pipeline[i]
    if (!step || typeof step !== "object") continue
    const entries = Object.entries(step)
    if (entries.length === 0) continue
    const [op, params] = entries[0]!
    const handler = HANDLERS[op]
    if (!handler) {
      throw new Error(`Unknown pipeline step "${op}" at index ${i}`)
    }
    data = await handler(page, params, data, args)
  }
  return data
}
