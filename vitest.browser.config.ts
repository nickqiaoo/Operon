import path from 'path'
import { defineConfig } from 'vitest/config'

// Tests that need a real browser: native scroll anchoring, layout, ResizeObserver
// timing. jsdom stubs geometry, so the forked MessageScroller's scroll behaviour
// can only be proven here. Mirrors upstream packages/react/vitest.browser.config.ts.
export default defineConfig({
  define: {
    __APP_TARGET__: '"electron"',
    __APP_NATIVE__: false,
    __ENABLE_MEMORY__: false,
  },
  // Browser tests prebundle a different dependency graph than the running app.
  cacheDir: 'node_modules/.vite-vitest-browser',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
  test: {
    include: ['src/**/*.browser.test.{ts,tsx}'],
    setupFiles: ['./src/lib/shadcn-react/vitest.browser.setup.ts'],
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      name: 'chromium',
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom/client', 'react/jsx-dev-runtime'],
  },
})
