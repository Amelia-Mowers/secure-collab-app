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

The native build bundles SQLite (compiled from source), so it links without a
system `sqlite3` — it just needs a C toolchain (MSVC Build Tools on Windows,
`cc` elsewhere). Builds and runs natively on Windows, macOS, and Linux.

State is persisted under `~/.tidework/` (`%USERPROFILE%\.tidework\` on Windows):

| file/dir       | purpose                                                    |
| -------------- | ---------------------------------------------------------- |
| `config.json`  | the homeserver URL                                         |
| `session.json` | the saved session blob (access token + device), bridge-compatible |
| `store/`       | the persistent SQLite crypto store (device + Megolm keys)  |

The crypto store is what lets the CLI decrypt existing encrypted workspaces
across runs without re-verifying the device every time.

## Commands

Login **always verifies the device** against your secure backup using your
recovery (master) key — the same step the web app's "verify this device" gate
performs. This is mandatory: an unverified device can't decrypt workspaces
created on your other devices, and won't back up the ones it creates (so they'd
be invisible elsewhere). Provide the key with `--recover-key`, the
`TIDEWORK_RECOVERY_KEY` env var (preferred — keeps it out of shell history), or
the interactive prompt.

```sh
# OAuth / MAS login (browser sign-in) — required for the production homeserver,
# which has password login disabled. Opens your browser; the CLI listens on a
# loopback port for the redirect and finishes automatically. Then it verifies
# the device from backup (prompts for the recovery key if not in the env):
TIDEWORK_RECOVERY_KEY="abcd efgh …" tidework login --sso --homeserver https://matrix.tidework.io

# Password login (standard Matrix auth). Prefer the env vars so secrets stay out
# of shell history:
TIDEWORK_PASSWORD=… TIDEWORK_RECOVERY_KEY="…" \
  tidework login --homeserver https://example.org --user alice

tidework whoami      # show the logged-in user, or report none
tidework logout      # forget the session and delete the local crypto store
```

`login` always starts from a clean slate — it clears any existing session and
crypto store first, so you never have to `logout` by hand. Each login mints a
new device, and a store still holding the old one would refuse to open ("the
account in the store doesn't match the account in the constructor"). The
trade-off: a login that fails partway leaves you logged out rather than falling
back to the previous session.

When run inside WSL, the loopback redirect (`http://127.0.0.1:<port>/…`) is
reachable from the Windows browser via WSL2's localhost forwarding, so `--sso`
works end to end. If the browser can't be opened automatically, copy the printed
URL.

### Workspaces, tables, rows

A workspace is an encrypted Matrix room; a `<ws>` argument is either a room id
(starts with `!`) or a workspace name. A `<table>` is its id or display name.

```sh
tidework workspace create "Issues"          # create an encrypted workspace
tidework workspace list                      # NAME + ROOM ID

# Columns are name:type[:opt1|opt2|...] (type ∈
# text|number|boolean|date|select|multiselect|document|json; defaults to text).
# The |-separated options give a select/multiselect its allowed values:
tidework table create "Issues" Bugs \
  --columns "title:text,status:select:open|closed,priority:number"
tidework table list "Issues"

# Add or reconfigure columns on an existing table:
tidework column add "Issues" Bugs "assignee:select:alice|bob"
tidework column set "Issues" Bugs status --options open,in-progress,closed --default open

# Cells are column=value (column id or name); the row id is generated + printed.
# A value for a select/multiselect with options must be one of them, else the
# write is rejected (multiselect takes a comma-separated list):
tidework row add "Issues" Bugs title="Login fails" status=open priority=1
tidework table show "Issues" Bugs            # cold-starts the room + renders rows

# Update an existing row by its id (the ROW column in `table show`). Only the
# named cells change — every other cell on the row is left untouched:
tidework row set "Issues" Bugs <row-id> status=closed

# Filter + sort (read-side). --where is repeatable (AND); ops are = != ~ > >= < <=.
# --sort takes a column; prefix - for descending, repeat for multi-key:
tidework table show "Issues" Bugs --where status=open --sort priority
tidework table show "Issues" Bugs --where priority<=1 --where title~login --sort -opened
```

Read commands cold-start the workspace by replaying the room's history, so they
reflect everything written by any device. Writes are sent as a single batch
event (one Matrix event), so a multi-cell write isn't throttled by the
homeserver's per-message rate limit.

## Status

Auth + core CRUD are complete and validated end-to-end against production:
persistent SQLite store, session save/restore, **password** + **OAuth/MAS**
login, **workspace** create/list, **table** create/list/show, and **row** add.
Still to come: row/column delete + reorder, and a **bench** command.
