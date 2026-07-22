import { defineConfig, defaultExclude } from 'vitest/config'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import path from 'path'

export default defineConfig({
  // Mirror vite.config.ts's injected build id (tests assert version-mismatch
  // behavior against this fixed value).
  define: {
    __BUILD_ID__: JSON.stringify('test-build'),
  },
  plugins: [react(), wasm()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    // The e2e/*.spec.ts files are Playwright tests, not Vitest.
    exclude: [...defaultExclude, 'e2e/**'],
  },
})
