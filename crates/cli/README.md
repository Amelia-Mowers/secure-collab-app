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
# OAuth / MAS login (browser sign-in) — required for the production homeserver,
# which has password login disabled. Opens your browser; the CLI listens on a
# loopback port for the redirect and finishes automatically:
tidework login --sso --homeserver https://matrix.tidework.io

# Password login (standard Matrix auth). Prefer the env var so the password
# stays out of shell history:
TIDEWORK_PASSWORD=… tidework login --homeserver https://example.org --user alice

tidework whoami      # show the logged-in user, or report none
tidework logout      # forget the session and delete the local crypto store
```

When run inside WSL, the loopback redirect (`http://127.0.0.1:<port>/…`) is
reachable from the Windows browser via WSL2's localhost forwarding, so `--sso`
works end to end. If the browser can't be opened automatically, copy the printed
URL.

## Status

Auth is complete: persistent SQLite store, session save/restore, **password**
login, and **OAuth/MAS** login (validated end-to-end against the production
homeserver). Still to come: **workspace/table/row/cell CRUD** and a **bench**
command.
