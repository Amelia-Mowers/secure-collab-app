import { defineConfig, defaultExclude } from 'vitest/config'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import path from 'path'

export default defineConfig({
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
