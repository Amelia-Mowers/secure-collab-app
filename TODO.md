# Project TODO / Backlog

**Active task management has moved into the product itself** — the outstanding
backlog now lives as the `Issues` table in the **TideWork PM** workspace on the
production homeserver (TideWork dogfooding TideWork). This file is no longer the
source of truth for open work; it's a pointer.

## Where the backlog lives

- Homeserver: `https://matrix.tidework.io`
- Workspace: **TideWork PM** — room `!JGjEYLjqGJRfCDfSAG:tidework.io`
- Table: **Issues** — columns `name`, `status` (open · in-progress · closed),
  `description` (markdown), `priority` (0 = highest), `opened`, `closed`

## How to read / edit it

Use the native `tidework` CLI (`crates/cli`, see its README) or the web app.

```sh
# One-time: log in (OAuth/MAS) and verify the device from backup (recovery key).
tidework login --sso --homeserver https://matrix.tidework.io

tidework table show "TideWork PM" Issues                       # the backlog
tidework row add  "TideWork PM" Issues name="…" status=open priority=1 \
  opened=2026-06-20 description="…"                            # file an issue
tidework column set "TideWork PM" Issues status \
  --options open,in-progress,closed                            # configure a column
```

> Filtering/sorting from the CLI (e.g. open issues by priority) is itself a
> tracked issue — until it lands, `table show` lists every row in row-id order.

## History & rationale

- The detailed **completed-work log** (everything shipped, with notes and ADR
  refs) that used to live here is preserved in this file's **git history** — see
  the commit before the "repoint task management" change.
- Architecture rationale: [`ARCHITECTURE_REVIEW.md`](./ARCHITECTURE_REVIEW.md)
  and [`docs/adr/`](./docs/adr/).
- Current status snapshot: [`STATUS.md`](./STATUS.md).
