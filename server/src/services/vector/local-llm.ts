/**
 * Local LLM service using node-llama-cpp for embedding and reranking.
 *
 * Models:
 * - Dense embedding: Qwen3-Embedding-0.6B-GGUF
 * - Reranker: Qwen3-Reranker-0.6B-Q8_0-GGUF
 *
 * Ported from QMD's LlamaCpp class, simplified for XUI (embed + rerank only).
 */
import type {
  Llama,
  LlamaModel,
  LlamaEmbeddingContext,
} from 'node-llama-cpp'
import { homedir } from 'os'
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'

declare const __ENABLE_MEMORY__: boolean

// `node-llama-cpp` is loaded the same way `sqlite-vec-store.ts` loads `sqlite-vec`:
// required only when memory is enabled, never imported at module scope.
//
// The difference matters for headless deploys. `start.ts` and `app.ts` import
// this module unconditionally and guard every *call* with `__ENABLE_MEMORY__` —
// but a static `import ... from 'node-llama-cpp'` runs regardless of any guard,
// so the package had to be installed even where memory is switched off. On a
// tunnel node that meant carrying a multi-hundred-megabyte native LLM runtime
// for a feature that surface cannot reach. Both native packages are now
// optionalDependencies; `npm install --omit=optional` produces a node that
// starts fine with `ENABLE_MEMORY` unset.
//
// It has to be `import()`, not `createRequire()`: node-llama-cpp v3 is ESM with
// top-level await, and `require()` on such a graph throws
// ERR_REQUIRE_ASYNC_MODULE — which surfaced as every embedding/rerank call
// failing in the memory settings page.
type LlamaModule = typeof import('node-llama-cpp')
let llamaModule: Promise<LlamaModule> | null = null

function llamaAPI(): Promise<LlamaModule> {
  if (!llamaModule) {
    // Reached only from inside an `if (__ENABLE_MEMORY__)` branch. If it ever
    // fires with the package absent, the rejection is the honest outcome — the
    // alternative is a half-initialised embedding pipeline.
    llamaModule = import('node-llama-cpp') as Promise<LlamaModule>
  }
  return llamaModule
}

// =============================================================================
// Model Configuration
// =============================================================================

const EMBED_MODEL = 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf'
const RERANK_MODEL = 'hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf'

const MODEL_CACHE_DIR = join(homedir(), '.operon', 'models')
const DEFAULT_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

// =============================================================================
// Types
// =============================================================================

export interface RerankResult {
  id: string
  score: number
  index: number
}

export interface ModelStatus {
  name: string
  uri: string
  downloaded: boolean
  sizeBytes: number
}

export interface LocalLLMStatus {
  gpuType: string | false
  gpuDevices: string[]
  vram?: { total: number; used: number; free: number }
  cpuCores: number
  models: {
    embed: ModelStatus
    rerank: ModelStatus
  }
  downloading: boolean
}

interface HfRef {
  repo: string
  file: string
}

// =============================================================================
// Helpers
// =============================================================================

function parseHfUri(model: string): HfRef | null {
  if (!model.startsWith('hf:')) return null
  const without = model.slice(3)
  const parts = without.split('/')
  if (parts.length < 3) return null
  const repo = parts.slice(0, 2).join('/')
  const file = parts.slice(2).join('/')
  return { repo, file }
}

async function getRemoteEtag(ref: HfRef): Promise<string | null> {
  const url = `https://huggingface.co/${ref.repo}/resolve/main/${ref.file}`
  try {
    const resp = await fetch(url, { method: 'HEAD' })
    if (!resp.ok) return null
    return resp.headers.get('etag') || null
  } catch {
    return null
  }
}

function getModelFilename(uri: string): string | undefined {
  return uri.split('/').pop()
}

function findCachedModel(filename: string): string | null {
  if (!existsSync(MODEL_CACHE_DIR)) return null
  const entries = readdirSync(MODEL_CACHE_DIR, { withFileTypes: true })
  const found = entries.find((e) => e.isFile() && e.name.includes(filename) && e.name.endsWith('.gguf'))
  return found ? join(MODEL_CACHE_DIR, found.name) : null
}

// =============================================================================
// LocalLLM Class
// =============================================================================

export class LocalLLM {
  private llama: Llama | null = null
  private embedModel: LlamaModel | null = null
  private embedContexts: LlamaEmbeddingContext[] = []
  private rerankModel: LlamaModel | null = null
  private rerankContexts: Awaited<ReturnType<LlamaModel['createRankingContext']>>[] = []

  private embedModelLoadPromise: Promise<LlamaModel> | null = null
  private rerankModelLoadPromise: Promise<LlamaModel> | null = null
  private embedContextsCreatePromise: Promise<LlamaEmbeddingContext[]> | null = null

  private inactivityTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private downloading = false

  // ---- Activity management ----

  private touchActivity(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
      this.inactivityTimer = null
    }

    if (this.hasLoadedContexts()) {
      this.inactivityTimer = setTimeout(() => {
        this.unloadIdleResources().catch((err) => {
          console.error('[LocalLLM] Error unloading idle resources:', err)
        })
      }, DEFAULT_INACTIVITY_TIMEOUT_MS)
      this.inactivityTimer.unref()
    }
  }

  private hasLoadedContexts(): boolean {
    return this.embedContexts.length > 0 || this.rerankContexts.length > 0
  }

  private async unloadIdleResources(): Promise<void> {
    if (this.disposed) return

    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
      this.inactivityTimer = null
    }

    for (const ctx of this.embedContexts) {
      await ctx.dispose()
    }
    this.embedContexts = []

    for (const ctx of this.rerankContexts) {
      await ctx.dispose()
    }
    this.rerankContexts = []

    console.log('[LocalLLM] Unloaded idle contexts (models kept warm)')
  }

  // ---- Initialization ----

  private async ensureLlama(): Promise<Llama> {
    if (this.llama) return this.llama

    const { getLlama, getLlamaGpuTypes, LlamaLogLevel } = await llamaAPI()
    // @ts-expect-error node-llama-cpp API compat
    const gpuTypes = await getLlamaGpuTypes()
    const preferred = (['cuda', 'metal', 'vulkan'] as const).find((g) => gpuTypes.includes(g))

    let llama: Llama
    if (preferred) {
      try {
        llama = await getLlama({ gpu: preferred, logLevel: LlamaLogLevel.error })
      } catch {
        llama = await getLlama({ gpu: false, logLevel: LlamaLogLevel.error })
        console.warn(`[LocalLLM] ${preferred} reported available but failed. Falling back to CPU.`)
      }
    } else {
      llama = await getLlama({ gpu: false, logLevel: LlamaLogLevel.error })
    }

    if (!llama.gpu) {
      console.warn('[LocalLLM] No GPU acceleration, running on CPU (slower embeddings).')
    }

    this.llama = llama
    return llama
  }

  private ensureModelCacheDir(): void {
    if (!existsSync(MODEL_CACHE_DIR)) {
      mkdirSync(MODEL_CACHE_DIR, { recursive: true })
    }
  }

  private async resolveModel(modelUri: string): Promise<string> {
    this.ensureModelCacheDir()
    return await (await llamaAPI()).resolveModelFile(modelUri, MODEL_CACHE_DIR)
  }

  // ---- Model pulling ----

  async pullModels(): Promise<void> {
    this.downloading = true
    try {
      const models = [EMBED_MODEL, RERANK_MODEL]
      this.ensureModelCacheDir()

      for (const model of models) {
        const hfRef = parseHfUri(model)
        const filename = getModelFilename(model)
        if (!filename) continue

        const entries = existsSync(MODEL_CACHE_DIR)
          ? readdirSync(MODEL_CACHE_DIR, { withFileTypes: true })
          : []
        const cached = entries
          .filter((entry) => entry.isFile() && entry.name.includes(filename))
          .map((entry) => join(MODEL_CACHE_DIR, entry.name))

        if (hfRef) {
          const etagPath = join(MODEL_CACHE_DIR, `${filename}.etag`)
          const remoteEtag = await getRemoteEtag(hfRef)
          const localEtag = existsSync(etagPath)
            ? readFileSync(etagPath, 'utf-8').trim()
            : null
          // If we can't fetch remote ETag, skip update when we already have the model
          if (!remoteEtag && cached.length > 0) {
            console.log(`[LocalLLM] Model ${filename} up to date (offline)`)
            continue
          }
          const shouldRefresh = cached.length === 0 || (remoteEtag && remoteEtag !== localEtag)

          if (shouldRefresh) {
            for (const candidate of cached) {
              if (existsSync(candidate)) unlinkSync(candidate)
            }
            if (existsSync(etagPath)) unlinkSync(etagPath)
          } else {
            console.log(`[LocalLLM] Model ${filename} up to date`)
            continue
          }
        }

        console.log(`[LocalLLM] Downloading ${filename}...`)
        const path = await (await llamaAPI()).resolveModelFile(model, MODEL_CACHE_DIR)
        console.log(`[LocalLLM] Downloaded ${filename} (${(statSync(path).size / 1024 / 1024).toFixed(1)} MB)`)

        if (hfRef) {
          const remoteEtag = await getRemoteEtag(hfRef)
          if (remoteEtag) {
            const etagPath = join(MODEL_CACHE_DIR, `${filename}.etag`)
            writeFileSync(etagPath, remoteEtag + '\n', 'utf-8')
          }
        }
      }
    } finally {
      this.downloading = false
    }
  }

  // ---- Embed model/context ----

  private async ensureEmbedModel(): Promise<LlamaModel> {
    if (this.embedModel) return this.embedModel
    if (this.embedModelLoadPromise) return await this.embedModelLoadPromise

    this.embedModelLoadPromise = (async () => {
      const llama = await this.ensureLlama()
      const modelPath = await this.resolveModel(EMBED_MODEL)
      const model = await llama.loadModel({ modelPath })
      this.embedModel = model
      this.touchActivity()
      return model
    })()

    try {
      return await this.embedModelLoadPromise
    } finally {
      this.embedModelLoadPromise = null
    }
  }

  private async computeParallelism(perContextMB: number): Promise<number> {
    const llama = await this.ensureLlama()

    if (llama.gpu) {
      try {
        const vram = await llama.getVramState()
        const freeMB = vram.free / (1024 * 1024)
        const maxByVram = Math.floor((freeMB * 0.25) / perContextMB)
        return Math.max(1, Math.min(2, maxByVram))
      } catch {
        return 2
      }
    }

    const cores = llama.cpuMathCores || 4
    const maxContexts = Math.floor(cores / 4)
    return Math.max(1, Math.min(4, maxContexts))
  }

  private async threadsPerContext(parallelism: number): Promise<number> {
    const llama = await this.ensureLlama()
    if (llama.gpu) return 0
    const cores = llama.cpuMathCores || 4
    return Math.max(1, Math.floor(cores / parallelism))
  }

  private async ensureEmbedContexts(): Promise<LlamaEmbeddingContext[]> {
    if (this.embedContexts.length > 0) {
      this.touchActivity()
      return this.embedContexts
    }
    if (this.embedContextsCreatePromise) return await this.embedContextsCreatePromise

    this.embedContextsCreatePromise = (async () => {
      const model = await this.ensureEmbedModel()
      const n = await this.computeParallelism(150)
      const threads = await this.threadsPerContext(n)
      for (let i = 0; i < n; i++) {
        try {
          this.embedContexts.push(
            await model.createEmbeddingContext({
              contextSize: LocalLLM.EMBED_CONTEXT_SIZE,
              ...(threads > 0 ? { threads } : {}),
            }),
          )
        } catch {
          if (this.embedContexts.length === 0)
            throw new Error('[LocalLLM] Failed to create any embedding context')
          break
        }
      }
      this.touchActivity()
      return this.embedContexts
    })()

    try {
      return await this.embedContextsCreatePromise
    } finally {
      this.embedContextsCreatePromise = null
    }
  }

  private async ensureEmbedContext(): Promise<LlamaEmbeddingContext> {
    const contexts = await this.ensureEmbedContexts()
    return contexts[0]!
  }

  // ---- Context size limits ----
  // Embedding inputs are short (queries/memory chunks), 2048 tokens is plenty.
  // Without this limit, Qwen3 defaults to 32K+ context which eats gigabytes per context.
  private static readonly EMBED_CONTEXT_SIZE = 2048
  private static readonly RERANK_CONTEXT_SIZE = 2048

  private async ensureRerankModel(): Promise<LlamaModel> {
    if (this.rerankModel) return this.rerankModel
    if (this.rerankModelLoadPromise) return await this.rerankModelLoadPromise

    this.rerankModelLoadPromise = (async () => {
      const llama = await this.ensureLlama()
      const modelPath = await this.resolveModel(RERANK_MODEL)
      const model = await llama.loadModel({ modelPath })
      this.rerankModel = model
      this.touchActivity()
      return model
    })()

    try {
      return await this.rerankModelLoadPromise
    } finally {
      this.rerankModelLoadPromise = null
    }
  }

  private async ensureRerankContexts(): Promise<
    Awaited<ReturnType<LlamaModel['createRankingContext']>>[]
  > {
    if (this.rerankContexts.length > 0) {
      this.touchActivity()
      return this.rerankContexts
    }

    const model = await this.ensureRerankModel()
    const n = await this.computeParallelism(1000)
    const threads = await this.threadsPerContext(n)
    for (let i = 0; i < n; i++) {
      try {
        this.rerankContexts.push(
          await model.createRankingContext({
            contextSize: LocalLLM.RERANK_CONTEXT_SIZE,
            flashAttention: true,
            ...(threads > 0 ? { threads } : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any),
        )
      } catch {
        if (this.rerankContexts.length === 0) {
          // Flash attention might not be supported - retry without
          try {
            this.rerankContexts.push(
              await model.createRankingContext({
                contextSize: LocalLLM.RERANK_CONTEXT_SIZE,
                ...(threads > 0 ? { threads } : {}),
              }),
            )
          } catch {
            throw new Error('[LocalLLM] Failed to create any rerank context')
          }
        }
        break
      }
    }
    this.touchActivity()
    return this.rerankContexts
  }

  // ---- Public API ----

  async embed(text: string): Promise<number[] | null> {
    this.touchActivity()
    try {
      const context = await this.ensureEmbedContext()
      const embedding = await context.getEmbeddingFor(text)
      return Array.from(embedding.vector)
    } catch (error) {
      console.error('[LocalLLM] Embedding error:', error)
      return null
    }
  }

  async rerank(
    query: string,
    documents: Array<{ id: string; text: string }>,
  ): Promise<RerankResult[]> {
    this.touchActivity()

    if (documents.length === 0) return []

    const contexts = await this.ensureRerankContexts()
    const model = await this.ensureRerankModel()

    // Truncate documents that exceed rerank context size
    const queryTokens = model.tokenize(query).length
    const maxDocTokens = LocalLLM.RERANK_CONTEXT_SIZE - 200 - queryTokens

    const truncatedDocs = documents.map((doc) => {
      const tokens = model.tokenize(doc.text)
      if (tokens.length <= maxDocTokens) return doc
      const truncatedText = model.detokenize(tokens.slice(0, maxDocTokens))
      return { ...doc, text: truncatedText }
    })

    const texts = truncatedDocs.map((d) => d.text)

    // Split across contexts for parallelism
    const n = contexts.length
    const chunkSize = Math.ceil(texts.length / n)
    const chunks = Array.from({ length: n }, (_, i) =>
      texts.slice(i * chunkSize, (i + 1) * chunkSize),
    ).filter((chunk) => chunk.length > 0)

    const allScores = await Promise.all(
      chunks.map((chunk, i) => contexts[i]!.rankAll(query, chunk)),
    )

    const flatScores = allScores.flat()
    return documents
      .map((doc, i) => ({
        id: doc.id,
        score: flatScores[i]!,
        index: i,
      }))
      .sort((a, b) => b.score - a.score)
  }

  // ---- Status ----

  async getStatus(): Promise<LocalLLMStatus> {
    const embedFilename = getModelFilename(EMBED_MODEL)
    const rerankFilename = getModelFilename(RERANK_MODEL)

    const embedCached = embedFilename ? findCachedModel(embedFilename) : null
    const rerankCached = rerankFilename ? findCachedModel(rerankFilename) : null

    let gpuType: string | false = false
    let gpuDevices: string[] = []
    let vram: { total: number; used: number; free: number } | undefined
    let cpuCores = 0

    try {
      const llama = await this.ensureLlama()
      gpuType = llama.gpu
      gpuDevices = await llama.getGpuDeviceNames()
      cpuCores = llama.cpuMathCores
      if (llama.gpu) {
        try {
          const state = await llama.getVramState()
          vram = { total: state.total, used: state.used, free: state.free }
        } catch { /* no vram info */ }
      }
    } catch { /* llama not available yet */ }

    return {
      gpuType,
      gpuDevices,
      vram,
      cpuCores,
      models: {
        embed: {
          name: 'Qwen3-Embedding-0.6B',
          uri: EMBED_MODEL,
          downloaded: !!embedCached,
          sizeBytes: embedCached ? statSync(embedCached).size : 0,
        },
        rerank: {
          name: 'Qwen3-Reranker-0.6B',
          uri: RERANK_MODEL,
          downloaded: !!rerankCached,
          sizeBytes: rerankCached ? statSync(rerankCached).size : 0,
        },
      },
      downloading: this.downloading,
    }
  }

  // ---- Lifecycle ----

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
      this.inactivityTimer = null
    }

    if (this.llama) {
      const disposePromise = this.llama.dispose()
      const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 1000))
      await Promise.race([disposePromise, timeoutPromise])
    }

    this.embedContexts = []
    this.rerankContexts = []
    this.embedModel = null
    this.rerankModel = null
    this.llama = null
    this.embedModelLoadPromise = null
    this.embedContextsCreatePromise = null
    this.rerankModelLoadPromise = null
  }
}

// =============================================================================
// Singleton
// =============================================================================

let instance: LocalLLM | null = null

export function getLocalLLM(): LocalLLM {
  if (!instance) {
    instance = new LocalLLM()
  }
  return instance
}

export async function disposeLocalLLM(): Promise<void> {
  if (instance) {
    await instance.dispose()
    instance = null
  }
}
