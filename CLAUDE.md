# CLAUDE.md

Guidance for Claude / AI agents working in this repository.

## Task management lives in the TideWork PM workspace (not TODO.md)

Outstanding work is tracked **inside the product** — the app dogfooding itself —
not in a markdown file. The backlog is the `Issues` table in the **TideWork PM**
workspace on the production homeserver:

- Homeserver: `https://matrix.tidework.io`
- Workspace: **TideWork PM** — room `!JGjEYLjqGJRfCDfSAG:tidework.io`
- Table: **Issues** — `name`, `status` (open · in-progress · closed),
  `description` (markdown), `priority` (0 = highest), `opened`, `closed`

Read or update it with the native `tidework` CLI (`crates/cli`):

```sh
tidework login --sso --homeserver https://matrix.tidework.io   # OAuth + recovery key
tidework table show "TideWork PM" Issues                       # the backlog
tidework row add  "TideWork PM" Issues name="…" status=open priority=1 opened=<date> description="…"
tidework column set "TideWork PM" Issues status --options open,in-progress,closed
```

`TODO.md` is now just a pointer to this; its historical completed-work log is in
git history. To file or update work, prefer the workspace over editing markdown.

## Building & verifying

- Native builds + the Matrix integration tests run via **WSL + Nix** (see the
  `verification-via-wsl-nix` memory). Use `CARGO_TARGET_DIR` off the OneDrive
  mount.
- The `tidework-cli` crate is a native binary in an otherwise wasm-first
  workspace. It's excluded from `default-members`, so build it explicitly:
  `cargo build -p tidework-cli`. It builds natively on Windows/macOS/Linux
  (bundled SQLite).
- Source files are LF; editing tools can flip line endings — run
  `sed -i 's/\r$//' <file>` before committing if a diff shows whole-file churn.

## Conventions

- Ship work as small PRs; merge when CI is green.
- Architecture rationale: `ARCHITECTURE_REVIEW.md` + `docs/adr/`. Status
  snapshot: `STATUS.md`.
