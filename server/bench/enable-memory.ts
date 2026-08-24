/**
 * Side-effect module: define the build-time `__ENABLE_MEMORY__` global before
 * any xui module that reads it (local-llm.ts, app.ts) is evaluated.
 *
 * In the real app this global is injected by vite at build time. When we run
 * the memory stack under `tsx` (no vite), the bare identifier would otherwise
 * throw a ReferenceError. Setting it on globalThis makes the unqualified read
 * resolve. This MUST be imported FIRST — ESM evaluates imports in source order,
 * so listing this import above the xui imports guarantees it runs before them.
 */

;(globalThis as Record<string, unknown>).__ENABLE_MEMORY__ = true
