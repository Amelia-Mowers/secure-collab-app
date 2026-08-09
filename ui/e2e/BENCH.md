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
| **M1** cold start vs size | **swept 2026-08-03** | 100 → 10k rows, every size bounded; table below |
| **M2** incremental load | **shipped** | warm 0.8–2.1 s across a hundredfold range, 78–89% off cold |
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

- **It is bounded by cell count, not edit history** — but only since
  2026-08-02. Every write bumps the stalest cells, and the walk now stops once
  a page adds no cell it has not already seen. Before that the bumps were
  written and nothing ever acted on them, so compaction was pure write cost.
- **Both fixes are known and filed.** Batched compaction bumps (`74931dfa`) cut
  the walk ~100× by refreshing many cells per event; native incremental load
  (`3ddb4e74`) skips the walk entirely for a device that has a snapshot. They
  are complementary — a snapshot cannot help a *new* device, which is the worse
  case and the one a new collaborator meets.

  > **Both have since shipped** (see the Status table). Left as written because
  > this section is a dated record of what was known on 2026-08-01, and
  > rewriting it would hide the order in which the shape was understood.
  > Re-measured 2026-08-09 at 100 rows in a realistically-edited room:
  > **25.0 s cold, 2.8 s warm — 88% off**, walk stopping on `covered`.

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

### What was actually wrong (2026-08-02)

The table above was arithmetic from measured constants, and two of its premises
were false. Both were found by making the walk report what it did
(`TIDEWORK_WALK_STATS=1`) rather than inferring from wall-clock.

**Nothing stopped the walk.** The bumps existed; no code used them. Every cold
start read to the beginning of the room regardless of how well the room was
compacted.

**And bumps could not cover the workspace anyway.** They were selected only from
the table being written. `_schema`/`_views`/`_tables` are never written by
ordinary editing, so those cells stayed pinned at the room's start forever —
and one unreachable cell forces a full walk no matter what the data tables do.
Measured on a 100-row workspace of ~1961 events: the newest 1000 events covered
all 438 `tasks` cells and **none** of the 109 system cells.

That is why every "after compaction" figure here was unobservable rather than
merely optimistic — including the ~41 s, which no measurement ever supported.
Treat the row as a projection, not a result, until a 10k corpus is walked.

**Warm loads over-fetched too.** Resuming pulled a full 1000-event page to pick
up a handful of new events, so incremental cost scaled with room size instead
of with what changed: ~1.5 s per single-cell CLI edit. At a 100-event
incremental page the same seeding runs at ~0.5 s per edit.

### What the bound is worth (measured 2026-08-02)

A 100-row workspace (547 cells) hand-edited to 3,312 events, walked by one
binary against one room, `--cold` both times:

| | events read | pages | cold start |
|---|---:|---:|---|
| bounded (`stopped: covered`) | 2,000 | 2 | 8393 / 8498 / 8301 ms |
| unbounded (`TIDEWORK_UNBOUNDED_WALK=1`) | 3,312 | 4 | 14234 / 14869 / 14148 ms |

**41% faster, 40% fewer events** — but the ratio is the least interesting part
of it. The bounded walk read 2,000 events because that is what covering 547
cells takes at this page size; it would read the same 2,000 from a room ten
times longer. The unbounded one reads the room. So the gap widens with age
rather than holding proportional, which is the property that makes a workspace
not get slower as it is used.

Two smaller rooms measured on the way, worth keeping because they explain why
earlier attempts looked like nothing was happening:

- **412 events** — one page. Nothing to save; the walk ends by running out of
  room, not by detecting coverage. Correct, and indistinguishable from broken.
- **1,712 events** — exactly two pages. The bound saved one empty round-trip
  and zero events.

Below ~2 pages the stop cannot pay, because a round-trip is the floor. Any
benchmark at that size measures page granularity, not compaction.

### The sweep (measured 2026-08-03)

Four sizes, one binary, one Synapse, one login per size. `--cold` ignores the
snapshot and replays history in full; warm is the same command against the same
state dir, resuming from the snapshot the cold runs wrote — so the saving is a
before/after and not two setups wearing the same label.

| rows | cells | events walked | stop | cold | warm | warm saves |
|-----:|------:|--------------:|------|-----:|-----:|-----------:|
| 100 | 700 | 2,000 | covered | 7164 ms | 782 ms | 89% |
| 1,000 | 7,000 | 2,000 | covered | 7222 ms | 1559 ms | 78% |
| 5,000 | 35,000 | 3,000 | covered | 10776 ms | 2065 ms | 80% |
| 10,000 | 70,000 | 4,000 | covered | 14673 ms | 1743 ms | 88% |

**Every size stops on coverage, and events walked grows with the workspace
rather than with the room.** A hundredfold more rows costs twice the events —
2,000 to 4,000 — because what the walk pays for is covering cells, not reading
history. Cold start does still grow (7.2 s → 14.7 s), and the extra is replay:
43,859 cells is 80× the 547-cell room's work no matter how few events carried
them.

Warm start is where a returning user lives, and it is 0.8–2.1 s across a
hundredfold range.

The 10k row is a **measurement now**, not the projection the ~41 s figure below
was. It came in at a third of that projection.

### One trap this sweep walked into, worth not repeating

The first attempt at this table failed outright: the measuring device could not
decrypt 2,903 of the events it had just been seeded with. The seeding CLI exits
seconds after writing, and the SDK backs new megolm sessions up from a background
task that had not gotten to them — so a device logging in afterwards had no way
to read them, permanently.

That is also the real explanation for the 5k/10k rooms that used to read their
whole history, and it had nothing to do with compaction. Undecryptable events
correctly block the coverage stop (a page you could not read contributes no new
cells; calling that "covered" would truncate the walk exactly when data is at
risk), so those walks ran to the start of the room. Three compaction-flavoured
explanations were proposed and disproved before this one — the earlier binaries
counted undecryptable events and carried on, so the cause could never show itself
as itself.

Fixed in the client (`wait_for_key_backup` before a write command exits), not in
the harness. **A benchmark that skips undecryptable events reports a fast cold
start for a workspace it could not read.**

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
