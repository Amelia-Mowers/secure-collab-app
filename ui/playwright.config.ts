import { defineConfig, devices } from '@playwright/test'
import { execSync } from 'node:child_process'

/**
 * Locate the Nix-provided Chromium binary. The Nix `playwright-driver.browsers`
 * lays chrome out under `chrome-linux64/`, whereas npm Playwright expects
 * `chrome-linux/`, so we point Playwright straight at the binary. Returns
 * undefined off Nix (or if not found), so Playwright falls back to its own
 * downloaded browser — keeping this portable to CI / non-Nix setups.
 */
function nixChromium(): string | undefined {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH
  // Only override for the Nix store layout; elsewhere (CI, plain installs)
  // let Playwright use its own browser at the path it expects.
  if (!base || !base.startsWith('/nix/')) return undefined
  try {
    const found = execSync(
      `find -L "${base}" -type f -name chrome -path '*chrome-linux*' 2>/dev/null | head -1`,
      { encoding: 'utf8' },
    ).trim()
    return found || undefined
  } catch {
    return undefined
  }
}

/**
 * Two-browser end-to-end harness (ADR 0001 Phase D).
 *
 * `globalSetup` boots a throwaway Synapse homeserver (the same one prod and the
 * Rust integration tests use) and exposes its URL via `E2E_HOMESERVER`. The web
 * server is the Vite dev server, which serves the app + the locally-built WASM
 * bindings. Tests open isolated browser contexts — two *devices* of one user
 * (verification / recovery) or two distinct *users* (collaboration) — and drive
 * the real flows.
 *
 * Run inside the Nix dev shell so `synapse_homeserver` is on PATH and Playwright uses the
 * Nix-provided browsers (PLAYWRIGHT_BROWSERS_PATH):
 *   nix develop --command bash -c "cd ui && npm run e2e"
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 45_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    actionTimeout: 30_000,
  },
  webServer: {
    command: 'npm run dev -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          executablePath: nixChromium(),
          // Required under WSL: no sandbox in the Nix store, and WSL's small
          // /dev/shm makes Chromium fail to spawn without --disable-dev-shm-usage.
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        },
      },
    },
  ],
})
