import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import type { LoggingFunction, RollupLog } from 'rollup'
import { execSync } from 'node:child_process'

const enableMemory = process.env.ENABLE_MEMORY !== 'false'
const enableFastRefresh = process.env.REACT_FAST_REFRESH !== 'false'
const buildTarget = process.env.OPERON_BUILD_TARGET === 'web' ? 'web' : 'electron'
const isWeb = buildTarget === 'web'
// The iOS shell (Capacitor) bundles this exact web build and loads it from
// disk. It stays `__APP_TARGET__ === 'web'` — same broker addressing, same
// components — and only flips the few behaviours that need a native API.
const isNative = process.env.OPERON_NATIVE === '1'
// The web target never bundles the Electron main/preload — force-skip the plugin.
const skipElectron = process.env.OPERON_SKIP_ELECTRON === '1' || isWeb

function killStaleElectronWindows() {
  try {
    const cwd = process.cwd()
    const output = execSync(
      `ps -eo pid,args | grep -i "[E]lectron" | grep "${cwd}" | awk '{print $1}'`,
      { encoding: 'utf8', maxBuffer: 1024 * 1024 }
    )
    output.trim().split('\n').filter(Boolean).forEach((pid) => {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {}
    })
  } catch {}
}

const createVendorChunkName = (id: string): string | undefined => {
  if (!id.includes('node_modules')) return undefined
  return 'vendor'
}

const warnUnlessKnown = (warning: RollupLog, warn: LoggingFunction): void => {
  if (warning.code === 'EVAL' && warning.id?.includes('node_modules/gray-matter/lib/engines.js')) {
    return
  }
  warn(warning)
}

export default defineConfig({
  define: {
    __ENABLE_MEMORY__: enableMemory,
    __APP_TARGET__: JSON.stringify(buildTarget),
    __APP_NATIVE__: isNative,
  },
  plugins: [
    tailwindcss(),
    react({
      fastRefresh: enableFastRefresh,
    }),
    // PWA only on the *browser* web target. Electron has no use for a service
    // worker, and neither does the iOS shell: its assets already come off local
    // disk, so a second cache layer buys nothing and costs the classic "app
    // still runs the previous build" ghost. Keep the plugin mounted when
    // disabled so virtual:pwa-register resolves in shared React code.
    VitePWA({
      disable: !isWeb || isNative,
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Operon',
        short_name: 'Operon',
        description: 'One Interface. Every Agent.',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b0b0d',
        theme_color: '#6358DC',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Cloudflare Pages already rewrites client routes to index.html. Do not
        // precache or use a navigation fallback here: a stale cached index can
        // reference hashed JS files that no longer exist after the next deploy,
        // leaving an installed PWA unable to boot and request its SW update.
        // Activate this recovery worker without waiting for the broken app shell
        // to send SKIP_WAITING; a white-screen client has no running JS to do so.
        skipWaiting: true,
        clientsClaim: true,
        navigateFallback: null,
        cleanupOutdatedCaches: true,
        importScripts: ['/sw-cache-cleanup.js'],
        // The app needs its remote runtime to be useful offline. Let Cloudflare
        // and the browser cache hashed code instead of allowing a service worker
        // to persist an HTML fallback under a missing script or stylesheet URL.
        globPatterns: ['**/*.{svg,png,ico,woff2}'],
      },
      // No service worker in dev (dev is plain http on a LAN anyway, where
      // SWs can't register). It kicks in for the production build.
      devOptions: { enabled: false },
    }),
    ...(skipElectron ? [] : [electron({
      main: {
        entry: 'electron/main.ts',
        onstart({ startup }) {
          killStaleElectronWindows()
          startup()
        },
        vite: {
          define: {
            __ENABLE_MEMORY__: enableMemory,
          },
          // The top-level `resolve.alias` only applies to the renderer build.
          // Main bundles `server/`, which shares tool-name contracts with the UI
          // via `@shared/*` — without this the main build fails to resolve them
          // and silently keeps serving the last bundle that built.
          resolve: {
            alias: {
              '@shared': path.resolve(__dirname, './shared'),
            },
          },
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // Only externalize packages with native addons / wasm / vendor binaries,
              // plus CJS packages that use __dirname (breaks when bundled into ESM).
              external: (id) => {
                if (id.startsWith('node:')) return true
                // Let Rollup inline JSON imports (ESM can't import JSON without attributes)
                if (id.endsWith('/package.json')) return false
                const nativeModules = [
                  'better-sqlite3',
                  'sharp',
                  '@anthropic-ai/claude-agent-sdk',
                  '@grpc/grpc-js',
                  '@google/gemini-cli-core',
                  'keytar',
                  'node-llama-cpp',
                  'tree-sitter-bash',
                  'web-tree-sitter',
                  'sqlite-vec',
                  '@lydell/node-pty',
                  'ws',
                  'bufferutil',
                  'utf-8-validate',
                  // In-process agent framework (workspace link). Pulls native
                  // deps (ssh2 -> cpu-features/cpufeatures.node) that can't be
                  // bundled; resolve at runtime via the symlinked dist instead.
                  'operon-agents',
                  'operon-agents-core',
                ]
                return nativeModules.some(m => id === m || id.startsWith(m + '/'))
              },
              output: {
                manualChunks(id) {
                  return createVendorChunkName(id)
                },
              },
              onwarn: warnUnlessKnown,
            }
          }
        }
      },
      preload: {
        // Object input → one output per key: preload.mjs + webview-preload.mjs.
        // webview-preload is injected into the browser sidebar's <webview>
        // guests (see electron/main.ts will-attach-webview).
        input: {
          preload: 'electron/preload.ts',
          'webview-preload': 'electron/webview-preload.ts',
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              output: {
                // The simple plugin defaults this to true (preloads are
                // single-file), which forbids multiple inputs. Our two preloads
                // share no runtime code, so disabling it just emits two files.
                inlineDynamicImports: false,
              },
            },
          }
        }
      },
    })]),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared')
    }
  },
  // Pin dep-scan to the real entry so the optimizer never crawls build output
  // (dist/, dist-web/) — a stale dist/index.html would otherwise drag in the
  // bundled vendor chunk's optional, uninstalled imports (e.g. @emotion/is-prop-valid).
  optimizeDeps: {
    entries: 'index.html',
  },
  base: isWeb ? '/' : './',
  // Pierre's diff highlighter runs in a web worker (@pierre/diffs worker pool)
  // that dynamically imports shiki language grammars. The default `iife` worker
  // format can't code-split, so emit ES-module workers (supported by Electron's
  // Chromium and all modern browsers).
  worker: {
    format: 'es',
  },
  build: {
    outDir: isWeb ? 'dist-web' : 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Electron loads its bundle from disk, so collapsing every dependency
        // into one chunk costs nothing there. On the web it is fatal: folding
        // all of node_modules into a single chunk defeats code splitting, so
        // shiki's per-language grammars (7MB), mermaid and cytoscape — all of
        // which are lazily imported and most of which a session never touches —
        // become part of the boot path. That pushed the entry graph to 15.6MB,
        // which a phone cannot download and evaluate inside the boot watchdog.
        // Letting Rollup split naturally leaves 4.7MB on the boot path.
        manualChunks: isWeb ? undefined : (id) => createVendorChunkName(id),
      },
    },
  },
  server: {
    port: 5173,
    watch: {
      ignored: ['**/e2e/**', '**/test-results/**', '**/playwright-report/**','.claude'],
    },
  }
})
