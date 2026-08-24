/**
 * vector/ — low-level vector + embedding + local LLM utilities.
 *
 * This barrel only re-exports the three long-lived primitives used by the
 * memory framework: SqliteVecStore (vector store), embeddings (1024-dim local
 * embeddings), and local-llm (rerank / generation). Higher-level memory
 * logic lives in services/memory/.
 */

export {
  initEmbeddingConfig,
  getEmbeddingConfig,
  updateEmbeddingConfig,
  generateEmbedding,
  type EmbeddingConfig,
} from './embeddings.js'

export { SqliteVecStore, type VectorFilter } from './sqlite-vec-store.js'
export { getLocalLLM, disposeLocalLLM } from './local-llm.js'
