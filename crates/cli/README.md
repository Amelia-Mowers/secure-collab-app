# tidework — native CLI

A native command-line client for the TideWork E2E-encrypted collaborative table
app. It reuses the same Rust core as the browser UI (`app-core` +
`tables-over-matrix`), so it can drive **real** workspaces against a homeserver
without a browser — handy for dogfooding and quick iteration (rebuild, not
redeploy).

## Build & run

The crate is excluded from the workspace's default members (it's a native
binary in an otherwise wasm-first workspace), so always target it explicitly:

```sh
cargo build -p tidework-cli          # produces the `tidework` binary
cargo run   -p tidework-cli -- --help
```

State is persisted under `~/.tidework/`:

| file/dir       | purpose                                                    |
| -------------- | ---------------------------------------------------------- |
| `config.json`  | the homeserver URL                                         |
| `session.json` | the saved session blob (access token + device), bridge-compatible |
| `store/`       | the persistent SQLite crypto store (device + Megolm keys)  |

The crypto store is what lets the CLI decrypt existing encrypted workspaces
across runs without re-verifying the device every time.

## Commands

```sh
# Password login (standard Matrix auth). Prefer the env var so the password
# stays out of shell history:
TIDEWORK_PASSWORD=… tidework login --homeserver https://example.org --user alice

tidework whoami      # show the logged-in user, or report none
tidework logout      # forget the session and delete the local crypto store
```

## Status

Phase 1 (this): foundation — persistent store, session save/restore, and
password login. **MAS/OAuth login** (required for the production homeserver,
which has password login disabled) and **workspace/table/row/cell CRUD** land in
follow-up phases.
