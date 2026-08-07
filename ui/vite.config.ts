import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import fs from 'fs'
import path from 'path'

// One id per build (CI sha, falling back to a timestamp for local builds).
// Baked into the bundle as __BUILD_ID__ AND emitted as /version.json, so a
// running client can detect that a newer deploy replaced its hashed assets
// (issue 9ac89444 — stale clients broke with unreachable-code errors).
const buildId = process.env.GITHUB_SHA ?? `dev-${Date.now()}`

// The released version, from the one file `scripts/release.sh` bumps. The app
// compares it to what a user has already been shown to decide whether there is
// anything new to tell them.
const appVersion = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
).version as string

// CHANGELOG.md, inlined at build time. It lives at the repo root because it is
// the project's changelog rather than the app's, and reading it here means the
// what's-new dialog and the git tag cannot disagree about what shipped — there
// is one file, not a copy. It is a few KB of text.
const changelog = fs.readFileSync(path.resolve(__dirname, '..', 'CHANGELOG.md'), 'utf8')

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
    __APP_VERSION__: JSON.stringify(appVersion),
    __CHANGELOG__: JSON.stringify(changelog),
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
