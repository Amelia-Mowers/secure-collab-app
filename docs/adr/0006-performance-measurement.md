# ADR 0006 — What we measure, and what we measure it with

**Status:** proposed
**Date:** 2026-08-01
**Issues:** `ab0a28d8` (CLI perf/bench subcommand), `278af524` (load-test harness),
`20e42198` (propagation p95)

## Context

The load test we have answers one question — *how many cell events per second
can the homeserver absorb* — and answers it well enough that the 2026-08-01 run
found the sync workers doubling collab throughput on the real client path.

It does not answer the questions users actually feel:

- **How long until I can use a workspace with thousands of rows?** (cold start)
- **How long on the second open?** (incremental load)
- **How many people can be working at once before it stops feeling live?**

Those are different measurements, and two of them cannot be taken with the
current instrument at all.

### What the existing instruments can and cannot do

**`loadtest-prod.mjs`** speaks raw CS-API and writes cell events. It has no
workspace materialisation, so "time to usable state" is not a thing it can
observe. It is the right tool for server capacity and the wrong one for client
latency.

**Playwright** materialises a real workspace but drags a browser, a renderer and
a wasm bridge into every measurement, and the harness already needs WSL + a
built wasm bundle to run at all. Fine for "does the demo render"; too noisy and
too slow for a latency benchmark, and impossible to run at N-way concurrency on
one box.

**The CLI** is the instrument this ADR is about. It is native, it does exactly
one full cycle per invocation — restore → `sync_once` → full history replay →
render → exit — and it has no UI. Process wall-clock *is* time-to-usable-state,
with nothing to subtract.

### What the CLI can do today (audited 2026-08-01)

- **Non-interactive auth already exists**: `--password` / `TIDEWORK_PASSWORD`
  and `--recover-key` / `TIDEWORK_RECOVERY_KEY`, with an explicit non-tty check
  that fails fast rather than prompting (`main.rs:586`). Scripted login works
  *against a homeserver with password auth enabled* — not prod, where password
  login is disabled and `--sso` needs a browser.
- **Sandboxing already half-exists**: `home_dir()` reads `HOME` then
  `USERPROFILE`, so `HOME=/tmp/bench-7 tidework …` relocates config, session and
  the SQLite store. It works, but it is a blunt instrument — it also redirects
  every other tool the process touches, and `HOME` is not the natural knob on
  Windows.
- **Bulk seeding exists**: `import` applies a whole archive and sends every
  resulting update in ONE `send_cell_batch` (`crud.rs:1240`).

### What it cannot do

1. **No incremental load.** `load_workspace` paginates the entire room backwards
   in pages of 1000 until exhausted, every invocation, and replays every update
   (`crud.rs:66-77`, `matrix.rs:1085-1135`). The snapshot machinery exists —
   `WorkspaceSnapshot`, `marker_ts`, and a bounded `gather_history` — but lives
   in `bridge_matrix.rs`, which is `#[cfg(feature = "wasm")]`. **Incremental
   cold start is web-only; the native path cannot reach it.**
2. **No timing instrumentation.** No `--json`, no `--verbose`, no spans of our
   own. Tracing goes to stderr at `warn` by default.
3. **No way to obtain a recovery key.** The CLI accepts one but never mints or
   prints one; `enable_recovery` is wired only to the wasm bridge. A benchmark
   account's key has to be minted in the web app by hand.
4. **`row add` cold-starts the whole workspace to write one row**
   (`crud.rs:736`). Seeding N rows with N invocations is O(N²).

## Decision

**The CLI is the benchmark instrument for client-side latency; the existing
Node driver stays the instrument for server capacity. They measure different
things and should not be merged.**

Four measurements, in the order they unblock each other:

### M1 — Cold start vs. workspace size

Wall-clock of `tidework table show` against workspaces seeded to 100 / 1k / 5k /
20k rows, with a fresh state dir each time. Every CLI invocation is already a
cold start, so this needs no new code beyond sandboxing and seeding.

Reported as a curve, not a number. The question is the *shape*: full replay is
expected to be linear in event count, and the 64 MB worker stack the CLI already
needs to avoid blowing the main stack on a large room (`main.rs:318`) says the
replay depth is a known hot spot.

### M2 — Incremental load

The same measurement with a warm state dir, once the native path can use a
snapshot. **This is the number that matters most**, because it is the one a
returning user experiences every day, and today it is identical to M1 — which is
itself the finding.

### M3 — Concurrent users

N sandboxed CLI instances against one workspace, each doing a realistic loop
(open, read, write a cell, close), reporting the distribution of time-to-usable
and of write→visible latency. This is where "how many users can we serve"
becomes answerable in the unit the question is asked in.

Note the ceiling: each instance costs a 64 MB stack plus 32 MB tokio workers, so
N-way concurrency on one box has a memory floor independent of the server.

### M4 — Write→visible propagation, native

Already measured over raw HTTP by the Node driver. Repeating it through the CLI
would measure the client's decrypt-and-materialise cost on top, which is what a
user actually waits for. Lowest priority — it duplicates M3's second half.

## Enabling work, smallest first

1. **`TIDEWORK_DATA_DIR`** — an explicit state-dir override, so a harness does
   not have to hijack `HOME`. *(Shipped with this ADR.)*
2. **Seed corpora + a seeding script** — `import` in chunks, since one giant
   batch is one Matrix event and will meet the 64 KiB event limit long before
   thousands of rows. Chunking belongs in the script, not in `import`.
3. **`tidework bench`** — the subcommand issue `ab0a28d8` already anticipates,
   emitting machine-readable timings (`--json`) so runs are diffable.
4. **Native incremental load** — lift `WorkspaceSnapshot` + a bounded
   `gather_history` out of the wasm-gated bridge into shared native code. The
   largest piece, and the one M2 depends on entirely.
5. **`tidework recovery show`** — so a harness can provision an account
   end-to-end without a browser. Needs care: it prints an unrecoverable secret,
   so it should refuse a tty-less pipe unless explicitly forced.

## Alternatives considered

**Extend the Node driver to materialise workspaces.** It would have to
reimplement the LWW replay in JavaScript — a second implementation of the thing
being measured, which would then need its own tests to be trusted. The CLI runs
*the real code*.

**Benchmark in-process with `cargo bench`.** Right for `Workspace::apply_update`
in isolation, and worth having, but it cannot see sync, decryption, pagination
or the network — which is where the time actually goes.

**Measure in the browser via Playwright.** Keeps the real client path, at the
cost of a browser in every sample and no realistic concurrency on one machine.
Reserve it for confirming that a CLI-measured regression is visible to users.

## Consequences

- **Benchmarks need a homeserver with password login enabled.** Prod disables
  it, and `--sso` needs a browser per sandbox. The integration harness's Synapse
  is the natural target; prod runs stay the Node driver's job.
- **M2 is blocked on real work, and that is the point.** "Second open is exactly
  as slow as the first" is a finding worth stating plainly rather than
  discovering by benchmark.
- **Numbers must record the instrument.** The 2026-08-01 run showed how easily
  a measurement point (`:8008` vs nginx) inverts a conclusion. Every result gets
  its instrument, its target and its state-dir policy recorded next to it.
