# Two-browser end-to-end tests

Playwright drives **two isolated browser contexts as two devices of one user**
(separate IndexedDB crypto stores) against a real, throwaway Conduit homeserver,
exercising the full stack — WASM crypto, Matrix, the WASM bridge, and the React
UI — that the unit/integration tests can't cover end to end.

## What's covered

- `smoke.spec.ts` — app boots, registers an account, first device bootstraps
  recovery (sanity check for the whole harness).
- `recovery.spec.ts` — a second device restores access with the **master key**.
- `verification.spec.ts` — two devices complete an **SAS (emoji) verification**
  and the new device's gate clears once trusted.
- `core.spec.ts` — the single-device product journey: workspace → table →
  a column of each type → entries → inline grid edit → header sort → global
  filter → kanban/card views → view switching → **persists across reload**
  (cold-start materialization). Also carries a `test.fixme` documenting that
  row deletion is local-only and does not survive a reload yet.

## Running

Run inside the Nix dev shell so `conduit` is on `PATH` and Playwright uses the
Nix-provided browsers (`PLAYWRIGHT_BROWSERS_PATH`, set by `flake.nix`). Build the
WASM bindings first (the dev server serves them from `src/wasm/generated/`):

```sh
nix develop --command bash -c '
  (cd crates/app-core && wasm-pack build --target web --out-dir ../../ui/src/wasm/generated \
     --no-default-features --features wasm,matrix-wasm)
  cd ui && npm install && npm run e2e
'
```

`global-setup.ts` boots Conduit on a free port and publishes its URL via
`E2E_HOMESERVER`; the Vite dev server serves the app. The Playwright config pins
`@playwright/test` to the same version as nixpkgs' `playwright-driver` (keep them
in sync if either is bumped). The Nix browser lays Chromium out under
`chrome-linux64/`, so `playwright.config.ts` points `executablePath` straight at
the binary (only when `PLAYWRIGHT_BROWSERS_PATH` is a `/nix/...` path).

## Troubleshooting

- **`browserType.launch: spawn EIO` / "browser has been closed" / `file too
  short`** — the Nix browser store path is corrupted (a download interrupted by,
  e.g., a WSL VM crash leaves truncated/empty binaries). Repair it (re-fetches
  from the binary cache):

  ```sh
  sudo nix-store --verify --check-contents --repair
  ```

- **`get-env.sh failed to produce an environment`** — CRLF line endings in
  `flake.nix` break the shell hook. `.gitattributes` forces `*.nix` to LF; if you
  hit this, run `sed -i 's/\r$//' flake.nix`.
