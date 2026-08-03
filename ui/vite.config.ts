import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import path from 'path'

// One id per build (CI sha, falling back to a timestamp for local builds).
// Baked into the bundle as __BUILD_ID__ AND emitted as /version.json, so a
// running client can detect that a newer deploy replaced its hashed assets
// (issue 9ac89444 — stale clients broke with unreachable-code errors).
const buildId = process.env.GITHUB_SHA ?? `dev-${Date.now()}`

const emitVersionJson = (): Plugin => ({
  name: 'emit-version-json',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: JSON.stringify({ build: buildId }),
    })
  },
})

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  // Base path for GitHub Pages: https://amelia-mowers.github.io/tidework/
  base: process.env.GITHUB_PAGES === 'true' ? '/tidework/' : '/',
  plugins: [react(), wasm(), emitVersionJson()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  worker: {
    format: 'es',
    plugins: () => [wasm()],
  },
  optimizeDeps: {
    exclude: ['app-core'],
  },
})
