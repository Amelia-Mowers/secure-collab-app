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
| **M1** cold start vs size | **run 2026-08-01** | results below |
| **M2** incremental load | **shipped** | 373 ms cold → 258 ms warm at 1000 rows; the win scales with events skipped |
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

## Results (2026-08-01, local Synapse, CLI instrument)

Fresh state dir per sample, median of three, loopback with no TLS.

| rows | events | median cold start |
|---:|---:|---:|
| 100 | 3 | 288 ms |
| 1000 | 29 | 687 ms |
| 2000 | 58 | 949 ms |

**Do not read those as user-facing numbers.** They were seeded with `import`,
which packs ~35 rows into one Matrix event — a shape no real workspace has.

### The decomposition, which is the actual finding

Same 200 rows (1400 cells), seeded two ways:

| packing | events | median |
|---|---:|---:|
| dense, 35 rows/event | 6 | 633 ms |
| sparse, 1 row/event | 200 | **1981 ms** |

Subtracting gives **~7 ms per event** and **~0.14 ms per cell**, on a
~250–400 ms fixed floor. **The per-event term dominates by roughly 7× at
realistic event counts.**

Writes are debounced 300 ms (`schedule_flush_with_delay(300)`), so deliberate
human editing produces roughly **one event per cell edit**. For a 10k-row ×
7-column workspace that is ~70k events ≈ **8 minutes on a device with no
snapshot**.

Two things keep that from being worse than it sounds:

- **It is bounded by cell count, not edit history.** Every write bumps the
  stalest cell, so the backward walk stops once the table is filled. A workspace
  does not get slower as it ages.
- **Both fixes are known and filed.** Batched compaction bumps (`74931dfa`) cut
  the walk ~100× by refreshing many cells per event; native incremental load
  (`3ddb4e74`) skips the walk entirely for a device that has a snapshot. They
  are complementary — a snapshot cannot help a *new* device, which is the worse
  case and the one a new collaborator meets.

## The 10k story

Constants all measured: **~7 ms per event walked**, **~0.14 ms per cell**, a
~325 ms floor, and — from the coverage test — **16 cells covered per event**.

A 10k-row × 7-column workspace edited by hand:

| | cells/event | events to walk | cold start |
|---|---:|---:|---:|
| 1 bump per write (original) | 1.0 | 70,000 | ~500 s |
| counter-based sweep | 3.96 | 17,700 | ~134 s |
| **per-write ×16 (current)** | **16.0** | **4,375** | **~41 s** |
| warm, with a snapshot | — | ~0 | **~0.3 s** |

### Two corrections worth keeping

**Batching into occasional sweeps barely helped.** The walk pays ~7 ms for
every event it passes, whether or not that event carries bumps — so refreshing
122 cells once per 100 writes raised the rate from 1.0 to 3.96 cells/event, not
to 122. An early version of this document claimed ~14 s at 10k rows on that
arithmetic; measuring coverage gave ~134 s.

**And the sweep could barely fire.** Its counter lived on `Workspace`, which is
rebuilt on every CLI command and every page load, so `tidework row set` — one
write per process — never reached the threshold. Compaction only worked inside a
long-lived browser session.

Both are why the trigger is now stateless: every write refreshes up to 16 stale
cells. Same total write cost as any batching scheme with the same refresh rate,
but it fires everywhere and raises the quantity that actually governs walk
length.

### The remaining shape

At 10k rows the ~41 s splits as ~31 s of event walking and ~10 s of cell replay.
More bumps per write keeps buying time until those cross over; past roughly ×32
the replay floor dominates and the only remaining lever is not walking at all —
which is what the snapshot does, and why warm start is ~0.3 s at any size.

## Reading the results

Record the **instrument, the target and the state-dir policy** next to every
number. The 2026-08-01 load test showed how easily a measurement point inverts a
conclusion — the same scenario read as a regression at `:8008` and a doubling
through nginx. A latency number without its instrument is not a result.
