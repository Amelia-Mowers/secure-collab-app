# Client-side benchmarks (ADR 0006)

Latency measurements through the **real client code**, using the CLI as the
instrument. Distinct from `LOADTEST.md`, which measures how many events per
second the *server* absorbs — these measure how long a *user* waits.

| | LOADTEST | BENCH |
|---|---|---|
| question | how much can the server take? | how long does a person wait? |
| instrument | Node driver, raw CS-API | `tidework` CLI |
| target | prod | a homeserver with password login |

## Why the CLI

One invocation is exactly one full cycle — restore → `sync_once` → paginate the
whole room → replay every update → render → exit — with no UI and nothing cached
in between. **Process wall-clock is time-to-usable-state**, with nothing to
subtract.

Extending the Node driver would mean reimplementing LWW replay in JavaScript: a
second copy of the thing being measured, which would then need its own tests to
be trusted. Playwright keeps the real path but puts a browser in every sample.

## Status

| | | |
|---|---|---|
| **M1** cold start vs size | harness ready, **not yet run** | everything it needs now exists |
| **M2** incremental load | **deferred** | worst-case cold start does not need it; seeding uses bulk `import`, not `row add`, so the O(N²) path is not on this road |
| **M3** concurrent users | not started | needs M1's seeding first |
| **M4** native propagation | not started | lowest priority; duplicates M3 |

## What exists

- **`bench-corpus.mjs`** — deterministic CSV-archive corpora. `node
  bench-corpus.mjs <out> <rows> [chunk]`. Same row count always produces
  byte-identical archives, so two runs measure the client and not the corpus.
  **Chunked** because `import` sends one archive as a single `send_cell_batch`,
  i.e. one Matrix event, and a few thousand rows in one archive meets the
  homeserver's 64 KiB event limit.
- **`bench-coldstart.sh`** — seeds a workspace at each size, then measures
  `table show` from a *fresh state dir* per sample. Also runs the command twice
  in one state dir, which is the M2 comparison: today the two numbers should be
  the same, and that equality *is* the finding.
- **`TIDEWORK_DATA_DIR`** — state-dir override, so each sample is genuinely cold
  and concurrent instances do not share a device. Verified: with it set the CLI
  reports "not logged in" while the real `~/.tidework` login is untouched.

## Running it

```sh
# 1. A standing Synapse with password login (prod disables it, and --sso needs
#    a browser per sandbox). Registers an account and prints its recovery key.
nix develop --command bash ui/e2e/bench-synapse.sh start

# 2. Benchmark, using the key from step 1.
export HOMESERVER=http://localhost:8448
export TIDEWORK_PASSWORD=bench-pw-2026
export TIDEWORK_RECOVERY_KEY='<printed by step 1>'
bash ui/e2e/bench-coldstart.sh benchuser 100 1000 5000

nix develop --command bash ui/e2e/bench-synapse.sh stop
```

Accounts are created with `tidework register`, which mints and prints the
recovery key. That matters beyond convenience: login **always** verifies against
secure backup, so an account made by a bare CS-API call cannot be logged into by
the CLI at all.

## Reading the results

Record the **instrument, the target and the state-dir policy** next to every
number. The 2026-08-01 load test showed how easily a measurement point inverts a
conclusion — the same scenario read as a regression at `:8008` and a doubling
through nginx. A latency number without its instrument is not a result.
