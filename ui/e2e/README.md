# Two-browser end-to-end tests

Playwright drives **isolated browser contexts** (separate IndexedDB crypto
stores) — two *devices* of one user, or two distinct *users* — against a real,
throwaway **Synapse** homeserver (the same one prod runs), exercising the full
stack — WASM crypto, Matrix, the WASM bridge, and the React UI — that the
unit/integration tests can't cover end to end.

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
- `collaboration.spec.ts` — **two distinct users**: A creates a workspace +
  table + rows, invites B; B joins and sees the **pre-join history** (MSC4268
  history-on-invite — needs Synapse), then live A↔B propagation, the member
  list, and same-cell **LWW convergence**.
- `oauth.spec.ts` — **SSO sign-in via MAS** through the real UI (ADR 0002):
  next-gen-auth detection swaps the password form for the popup flow → MAS
  hosted login → recovery bootstrap → workspaces → reload-restore. Needs the
  throwaway Synapse+MAS stack, so it self-skips in the normal run; execute it
  with `nix shell .#oauth-stack-tools --command nix develop --command bash
  scripts/spike-synapse-mas.sh --e2e` (the `e2e-oauth` CI job does the same).

## Running

Run inside the Nix dev shell so `synapse_homeserver` is on `PATH` and Playwright uses the
Nix-provided browsers (`PLAYWRIGHT_BROWSERS_PATH`, set by `flake.nix`). Build the
WASM bindings first (the dev server serves them from `src/wasm/generated/`):

```sh
nix develop --command bash -c '
  (cd crates/app-core && wasm-pack build --target web --out-dir ../../ui/src/wasm/generated \
     --no-default-features --features wasm,matrix-wasm)
  cd ui && npm install && npm run e2e
'
```

`global-setup.ts` boots Synapse on a free port and publishes its URL via
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
