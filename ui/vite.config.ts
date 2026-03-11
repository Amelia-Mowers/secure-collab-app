import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  // Base path for GitHub Pages: https://amelia-mowers.github.io/secure-collab-app/
  base: process.env.GITHUB_PAGES === 'true' ? '/secure-collab-app/' : '/',
  plugins: [react(), wasm()],
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
