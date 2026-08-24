// Entry point for running the server outside Electron — a node on a box with no
// desktop, reached only through the tunnel.
//
// The normal entry is `index.ts`, loaded by the Electron main bundle, where Vite
// replaces `__ENABLE_MEMORY__` at build time. Nothing does that substitution for
// a plain `tsx src/index.ts`, so the first module that reads the constant throws
// `ReferenceError: __ENABLE_MEMORY__ is not defined` before the server ever
// listens. This file defines it, then loads the real entry.
//
// Memory (the vector store) is off by default here: it pulls in two native
// packages — `sqlite-vec` and `node-llama-cpp`, the latter a multi-hundred-
// megabyte LLM runtime — that a tunnel node has no reason to carry, and the
// feature is not reachable from the mobile/web surface anyway. Both are
// optionalDependencies, so `npm install --omit=optional` gives a node that
// starts fine. Set ENABLE_MEMORY=true only where they are actually installed.
export {}

;(globalThis as Record<string, unknown>).__ENABLE_MEMORY__ = process.env.ENABLE_MEMORY === 'true'

await import('./index.js')
