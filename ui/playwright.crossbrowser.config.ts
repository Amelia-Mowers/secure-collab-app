import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

/**
 * Firefox + WebKit run of the SharedWorker specs only (issue 87bf86a6).
 *
 * OPT-IN, in its own config rather than as extra projects on the default one:
 * most of the suite is Chromium-bound anyway (the passkey and at-rest specs
 * drive a CDP virtual authenticator), so adding projects to
 * `playwright.config.ts` would have `npm run e2e` fail on tests that never
 * could pass elsewhere.
 *
 * What it exists to answer: the worker path needs a **module** SharedWorker
 * (`new SharedWorker(url, { type: 'module' })`), which is narrower than
 * SharedWorker itself. Per MDN's compat data that means Chrome 80+, Firefox 114+
 * (dynamic import in workers landed in 113, module shared workers in 114) and
 * Safari 16+ (the constructor is the binding constraint there; modules landed in
 * 15). Making the worker the ONLY path rests on those numbers, so they get
 * checked by running rather than by reading a table.
 *
 * STATUS 2026-07-26:
 *  - firefox: PASSES. Module SharedWorker, wasm-bindgen glue, and the IndexedDB
 *    crypto store all work, and both tabs write. (Firefox is also what caught a
 *    real ordering bug Chromium's timing hid — see the push-before-response note
 *    in `worker/dispatch.ts`.)
 *  - webkit: UNKNOWN, not failing. Playwright's Linux WebKit does not launch in
 *    this WSL + Nix environment — it hangs before producing any result at all,
 *    even with a 60s per-test timeout, so there is no signal to read either way.
 *    Run this config on a Mac (or in CI on macOS) to get one. Until then Safari
 *    rests on MDN's numbers, plus `workerSupportGap()`, which makes a browser
 *    that cannot do this say so rather than fail quietly.
 *
 *   cd ui && npx playwright test --config playwright.crossbrowser.config.ts
 *   cd ui && npx playwright test --config playwright.crossbrowser.config.ts --project=firefox
 */
export default defineConfig({
  ...base,
  testMatch: ['worker-boot.spec.ts', 'multi-tab.spec.ts'],
  projects: [
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
