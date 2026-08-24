import { defineCommand } from "../define.ts"
import {
  arxivFetch,
  normalizeArxivCategory,
  normalizeArxivLimit,
  parseEntries,
} from "./utils.ts"

export const search = defineCommand({
  site: "arxiv",
  name: "search",
  description: "Search arXiv papers",
  domain: "arxiv.org",
  access: "read",
  strategy: "public",
  browser: false,
  args: [
    { name: "query", required: true, positional: true },
    { name: "limit", type: "int", default: 10, help: "Max 25" },
  ],
  columns: ["id", "title", "authors", "published", "primary_category", "url"],
  func: async (_page, args) => {
    const queryText = String(args.query || "").trim()
    if (!queryText) throw new Error("arxiv.search: query required")
    const limit = normalizeArxivLimit(args.limit, 10, 25)
    const query = encodeURIComponent(`all:${queryText}`)
    const xml = await arxivFetch(`search_query=${query}&max_results=${limit}&sortBy=relevance`)
    const entries = parseEntries(xml)
    if (!entries.length) throw new Error("arxiv.search: no papers found")
    return entries.map((e) => ({
      id: e.id,
      title: e.title,
      authors: e.authors,
      published: e.published,
      primary_category: e.primary_category,
      url: e.url,
    }))
  },
})

export const paper = defineCommand({
  site: "arxiv",
  name: "paper",
  description: "Get arXiv paper details by ID",
  domain: "arxiv.org",
  access: "read",
  strategy: "public",
  browser: false,
  args: [{ name: "id", required: true, positional: true, help: "e.g. 1706.03762" }],
  columns: [
    "id",
    "title",
    "authors",
    "published",
    "updated",
    "primary_category",
    "categories",
    "abstract",
    "comment",
    "pdf",
    "url",
  ],
  func: async (_page, args) => {
    const xml = await arxivFetch(`id_list=${encodeURIComponent(String(args.id))}`)
    const entries = parseEntries(xml)
    if (!entries.length) throw new Error(`arxiv.paper: ${args.id} not found`)
    return entries[0]
  },
})

export const recent = defineCommand({
  site: "arxiv",
  name: "recent",
  description: "List recent arXiv submissions in a category",
  domain: "arxiv.org",
  access: "read",
  strategy: "public",
  browser: false,
  args: [
    { name: "category", required: true, positional: true, help: "e.g. cs.CL, cs.LG" },
    { name: "limit", type: "int", default: 10, help: "Max 50" },
  ],
  columns: ["id", "title", "authors", "published", "primary_category", "url"],
  func: async (_page, args) => {
    const category = normalizeArxivCategory(args.category)
    const limit = normalizeArxivLimit(args.limit, 10, 50)
    const query = encodeURIComponent(`cat:${category}`)
    const xml = await arxivFetch(
      `search_query=${query}&max_results=${limit}&sortBy=submittedDate&sortOrder=descending`,
    )
    const entries = parseEntries(xml)
    if (!entries.length) throw new Error(`arxiv.recent: no papers in ${category}`)
    return entries.map((e) => ({
      id: e.id,
      title: e.title,
      authors: e.authors,
      published: e.published,
      primary_category: e.primary_category,
      url: e.url,
    }))
  },
})

export const author = defineCommand({
  site: "arxiv",
  name: "author",
  description: "List arXiv papers by author (newest first)",
  domain: "arxiv.org",
  access: "read",
  strategy: "public",
  browser: false,
  args: [
    { name: "author", required: true, positional: true },
    { name: "limit", type: "int", default: 20, help: "Max 50" },
  ],
  columns: ["id", "title", "authors", "published", "primary_category", "url"],
  func: async (_page, args) => {
    const authorText = String(args.author || "").trim()
    if (!authorText) throw new Error("arxiv.author: author required")
    const limit = normalizeArxivLimit(args.limit, 20, 50)
    const query = encodeURIComponent(`au:"${authorText}"`)
    const xml = await arxivFetch(
      `search_query=${query}&max_results=${limit}&sortBy=submittedDate&sortOrder=descending`,
    )
    const entries = parseEntries(xml)
    if (!entries.length) throw new Error(`arxiv.author: no papers for "${authorText}"`)
    return entries.map((e) => ({
      id: e.id,
      title: e.title,
      authors: e.authors,
      published: e.published,
      primary_category: e.primary_category,
      url: e.url,
    }))
  },
})
