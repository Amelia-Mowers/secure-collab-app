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

All three constants below were measured, not estimated: **~7 ms per event**,
**~0.14 ms per cell**, a ~325 ms floor, and — from the sweep probe —
**133 bytes per bump, 122 cells per sweep** inside the 16 KiB budget.

A 10k-row × 7-column workspace, edited by hand (so ~one event per cell edit):

| | events to walk | cold start |
|---|---:|---:|
| before batched compaction | 70,000 | **~500 s** |
| after batched compaction | 573 | **~14 s** |
| warm, with a snapshot | ~0 | **~0.3 s** |

### Where the remaining 14 s goes

```
events:    573 × 7 ms    =  4.0 s
cells:  70,000 × 0.14 ms =  9.8 s   ← now the dominant term
```

That inversion is the useful part. Before compaction the walk was event-bound,
and shortening it was everything. Now it is **cell-bound**: even a perfect
sweep still has to replay every live cell. Raising the sweep budget from 16 KiB
to 32 KiB would buy about 2 s of the 14 s and double the size risk on an event
that also carries the user's own write — not a good trade.

So the next lever is not more compaction. It is either per-cell replay cost, or
not walking at all — which is what the snapshot does, and why warm start is
~0.3 s regardless of size.

### What this means for a launch claim

"A 10k-row workspace opens in about a second for anyone who has opened it
before, and about fifteen seconds on a brand-new device." Both halves are
honest, and the second is the one to keep improving.

## Reading the results

Record the **instrument, the target and the state-dir policy** next to every
number. The 2026-08-01 load test showed how easily a measurement point inverts a
conclusion — the same scenario read as a regression at `:8008` and a doubling
through nginx. A latency number without its instrument is not a result.
