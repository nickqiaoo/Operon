import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  define: {
    __ENABLE_MEMORY__: 'false',
    // vite.config.ts defines these for every real build; without them any module
    // that branches on the build target throws ReferenceError under test.
    __APP_TARGET__: '"electron"',
    __APP_NATIVE__: 'false',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: [
      'src/**/*.{test,spec}.ts',
      'src/**/*.{test,spec}.tsx',
      'shared/**/*.{test,spec}.ts',
      'agent-runtime/src/**/*.{test,spec}.ts',
      'server/src/**/*.{test,spec}.ts',
      'server/tests/**/*.{test,spec}.ts',
      'packages/*/**/*.{test,spec}.ts',
      'electron/**/*.{test,spec}.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**', '**/vendor/**'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    env: {
      OPERON_ENABLE_FAKE_RUNTIME: '1',
    },
  },
})
