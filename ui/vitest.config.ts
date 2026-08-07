import { defineConfig, defaultExclude } from 'vitest/config'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import path from 'path'

export default defineConfig({
  // Mirror vite.config.ts's injected build id (tests assert version-mismatch
  // behavior against this fixed value).
  define: {
    __BUILD_ID__: JSON.stringify('test-build'),
    // Fixed, so the what's-new tests assert against a known version and a known
    // changelog rather than against whatever the repo happens to say today.
    __APP_VERSION__: JSON.stringify('1.2.3'),
    __CHANGELOG__: JSON.stringify(`# Changelog

## 1.2.3 — 2026-01-03

- **Third** thing

## 1.2.2 — 2026-01-02

- Second thing
  continued on the next line

## 1.1.9 — 2026-01-01

- First thing
`),
  },
  plugins: [react(), wasm()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // Tests run as the build WE ship, so the sign-in page offers the official
    // server exactly as a user of app.tidework.io sees it. A self-hosted build
    // is a different case and is covered explicitly in branding.test.ts.
    env: {
      VITE_DEFAULT_HOMESERVER: 'https://matrix.tidework.io',
    },
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    // The e2e/*.spec.ts files are Playwright tests, not Vitest.
    exclude: [...defaultExclude, 'e2e/**'],
  },
})
