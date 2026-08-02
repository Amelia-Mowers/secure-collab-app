# Capacity / load testing against prod

Scripts to drive real load against the production homeserver
(`https://matrix.tidework.io`) and find its capacity. Built for the
"Capacity / load-testing scripts against prod" backlog item.

> ⚠️ These hit **production**. They provision throwaway accounts, temporarily
> relax Synapse rate limits, and must be torn down afterwards. Only run when
> there are no real users (as of this writing there are none). Account tokens
> are secrets — the accounts JSON is never committed.

## The harness

| File | Where it runs | What it does |
|------|---------------|--------------|
| `loadtest-provision.sh` | droplet | Bulk-creates N `loadtestN` accounts via `mas-cli` and emits `[{username, token, device}]` JSON (mas compatibility tokens — usable directly against the CS-API, no login/OAuth). |
| `loadtest-prod.mjs` | anywhere (Node 18+) | The driver. Two modes: `capacity` (each account its own room, sends cell-updates at a target rate) and `collab` (all accounts share one room, measuring write→sync propagation latency). No deps. |
| `loadtest-run.sh` | droplet | Runs the driver in a throwaway `node:20-alpine` container against `127.0.0.1:8008` (no nginx/TLS/RTT) for clean server-capacity numbers. |
| `loadtest-suite.sh` | droplet | Runs the full scenario set (capacity ramp + A/B + collab), sampling Synapse container CPU/mem during each. |
| `loadtest-relax-limits.sh` | droplet | Backs up the live Synapse config and appends a relaxed rate-limit block (so the test finds raw capacity, not the configured policy), then restarts. |
| `loadtest-restore-limits.sh` | droplet | Reverts the above from the backup and restarts. **Always run after testing.** |
| `loadtest-teardown.sh` | droplet | Deactivates+erases the `loadtestN` accounts (Synapse admin API) and locks+kills their sessions (MAS). |

## Running it (the procedure used)

```sh
# 1. provision (on droplet) — writes JSON to /tmp, scp it back; DO NOT COMMIT
scp ui/e2e/loadtest-provision.sh root@<droplet>:/tmp/
ssh root@<droplet> 'bash /tmp/loadtest-provision.sh 100 > /tmp/loadtest-accounts.json'
scp root@<droplet>:/tmp/loadtest-accounts.json "$TEMP/loadtest-accounts.json"

# 2. relax limits (on droplet)
ssh root@<droplet> 'bash /tmp/loadtest-relax-limits.sh'

# 3. run the suite (on droplet, detached — ~7 min)
scp ui/e2e/{loadtest-prod.mjs,loadtest-run.sh,loadtest-suite.sh} root@<droplet>:/tmp/
ssh root@<droplet> 'nohup bash /tmp/loadtest-suite.sh > /tmp/lt-suite.log 2>&1 &'

# 4. restore limits + tear down accounts (on droplet)
ssh root@<droplet> 'bash /tmp/loadtest-restore-limits.sh'
ssh root@<droplet> 'bash /tmp/loadtest-teardown.sh 100'
```

The driver can also run from a dev box against the public URL
(`HOMESERVER=https://matrix.tidework.io node loadtest-prod.mjs --mode capacity
--accounts 100 --rate 1 --duration 25`); expect ~250 ms of client RTT added to
every latency.

---

## Results (2026-08-01, droplet = 2 vCPU / 3.8 GB, Synapse **+ 3 workers**)

Same box, same scenarios, but Synapse now runs as main + persister + 2 sync
workers behind nginx. Rate limits relaxed for the run and **restored**; all
accounts torn down. Zero errors and zero 429s in every scenario below.

> **Read the two tables as different things.** `:8008` talks to the MAIN
> process only, so it now measures roughly a quarter of the deployed system —
> the sync workers sit idle at 1–7%. The nginx table is the path a real client
> takes. The 2026-06-30 baseline below was a monolith, where `:8008` *was* the
> whole server; comparing today's `:8008` numbers against it compares a shared
> process to a machine.

### Capacity, direct to the main process (`:8008`)

| Scenario | Achieved | p50 | p95 | main | persister | sync1/2 | combined (of 200%) |
|---|---:|---:|---:|---:|---:|---:|---:|
| S1 25 @1/s   | 13.9/s | 1310 ms | 3017 ms | 79% | 46% | 5/17% | 107% |
| S2 50 @0.5/s | 14.2/s | 1893 ms | 3709 ms | 81% | 62% | 5/7%  | 127% |
| S3 50 @1/s   | 12.1/s | 2419 ms | 3931 ms | 82% | 66% | 4/6%  | 133% |
| S4 100 @1/s  |  7.2/s | 5153 ms | 7745 ms | 91% | 67% | 10/5% | 135% |
| S5 100 @2/s  |  5.4/s | 8560 ms | 10218 ms | 76% | 67% | 11/10% | 136% |
| S6 100 @4/s  |  2.6/s | 8160 ms | 8220 ms | 87% | 62% | 9/7%  | 123% |

### Collaboration, the real client path (nginx → sync workers)

| Scenario | Throughput | Send p50 | **Propagation p50** | **p95** | main | sync1 | sync2 |
|---|---:|---:|---:|---:|---:|---:|---:|
| CN1 25 @0.5/s | **11.0/s** | 2284 ms | **3584 ms** | 20755 ms | 38% | 39% | 55% |
| CN2 50 @0.5/s | **11.4/s** | 4857 ms | **6733 ms** | 15495 ms | 64% | 56% | 54% |

The same collab scenarios driven at `:8008`, where `/sync` never reaches a
worker, managed 3.4/s and 4.4/s with propagation p50 of 7.3 s and 20.5 s. That
gap — 3.4 vs 11.0, 20.5 s vs 6.7 s — **is** the workers doing their job.

## What it means (2026-08-01)

1. **The workers are a real win, and only visible through nginx.** On the
   client path, collab throughput roughly doubled against the June monolith
   (5.3/s → 11.4/s at 50 members) and the load genuinely spreads
   (main 64%, sync1 56%, sync2 54%). Measured at `:8008` the same test looks
   *worse* than June, because there the main process is one of four
   contenders for two cores instead of owning the machine.

2. **Propagation p95 is now the ugly number.** p50 improved, but p95 sits at
   15–21 s. Median latency got better while the tail got worse, which is what
   queueing behind a saturated box looks like.

3. **The box is still the ceiling.** Combined CPU peaks at 107–136% of 200%,
   with the main process alone at 76–91%. Splitting into four processes cannot
   create cores; it only stops `/sync` from competing with writes. Past this,
   more capacity means a bigger droplet, not more workers.

4. **Re-baseline before the next comparison.** The June figures are a monolith
   at `:8008`. Now that the deployed topology has four processes, `:8008` is a
   component test and nginx is the system test — future runs should compare
   nginx-to-nginx.

### Harness fixes this run depended on

The first three attempts produced numbers that were entirely artefacts of the
harness, and none of them errored — they all just reported figures:

- Re-using an account prefix a previous teardown had **deactivated** yielded
  tokens Synapse rejects, and the driver reported **0 sends across every
  scenario**. Provisioning now verifies a token and refuses to continue.
- An **uppercase** prefix makes every Matrix username invalid; the failures
  were swallowed and the script emitted a well-formed **empty array**.
  Provisioning now fails when it creates nothing.
- Collab **invites were rate-limited (429)** and the driver ignored the status,
  so those accounts then failed to **join with 403** and silently sat out the
  test. Invites now retry on the server's own `retry_after_ms`, and a failed
  invite or join is fatal.
- Relax/restore-limits restarted **only the monolith**, leaving the workers on
  the old limits — a config change whose whole purpose is lifting a limit may
  not have been in force where it mattered.
- The CPU sampler named one container out of four, so every "peak CPU" line was
  **empty**.
- The collab clock started **before** room setup, so populating a 50-account
  room consumed the entire 30 s window and the scenario reported 0 sends.

---

## Results (2026-06-30, droplet = 2 vCPU / 3.8 GB, Synapse v1.148 monolith)

Rate limits relaxed for the run; **restored afterwards**. Driver hit Synapse
directly at `127.0.0.1:8008` except the off-box confirmation row.

### Capacity (independent rooms — per-user write path)

| Scenario | Writers | Target | Achieved | p50 | p95 | p99 | Synapse CPU |
|----------|--------:|-------:|---------:|----:|----:|----:|------------:|
| S1 | 25 @1/s   | 25/s  | **20.9/s** | 523 ms | 993 ms | 1178 ms | 120% |
| S2 | 50 @0.5/s | 25/s  | 17.0/s | 845 ms | 2222 ms | 2557 ms | 115% |
| S3 | 50 @1/s   | 50/s  | 20.4/s | 1684 ms | 2650 ms | 2717 ms | 118% |
| S4 | 100 @1/s  | 100/s | 12.1/s | 3377 ms | 4263 ms | 4436 ms | 120% |
| S5 | 100 @2/s  | 200/s | 12.4/s | 3483 ms | 3944 ms | 4117 ms | 120% |
| S6 | 100 @4/s  | 400/s | 5.0/s  | 3971 ms | 4657 ms | 4708 ms | 121% |
| S4-offbox | 100 @1/s (driver on a separate machine) | 100/s | 12.0/s | 3755 ms | 3974 ms | 4050 ms | 121% |

### Collaborative editing (one shared room — fan-out write path)

| Scenario | Members | Send p50 | Send p95 | **Propagation p50** | **Propagation p95** | Throughput | Synapse CPU |
|----------|--------:|---------:|---------:|--------------------:|--------------------:|-----------:|------------:|
| S7 | 25 @0.5/s | 1612 ms | 5550 ms | **2093 ms** | **6079 ms** | 8.0/s | 112% |
| S8 | 50 @0.5/s | 3526 ms | 10533 ms | **4358 ms** | **10110 ms** | 5.3/s | 116% |

Zero `429`s, zero errors in every scenario.

## What it means

1. **The bottleneck is Synapse's single-process CPU.** It pins at ~115–121%
   (≈1.2 of 2 vCPU) the moment load arrives (baseline 0.26%) and never moves;
   RAM never exceeded ~185 MB of 3.8 GB. The off-box run (driver on a separate
   machine) produced an identical 12/s and 121% CPU, ruling out the test client
   as the limiter. **CPU-bound, not memory- or network-bound.**

2. **Write ceiling ≈ 20 cell-events/s** for independent rooms at low
   concurrency. Past ~25 simultaneous writers you don't get more throughput —
   you get the same ~12–20/s with rapidly climbing latency (queueing). At a
   400/s offered load it *collapses* to 5/s.

3. **Concurrency, not aggregate rate, is the cost.** S1 vs S2 hold aggregate at
   25/s: 25 writers → p99 1.2 s, but 50 writers → p99 2.6 s (2× worse). Fewer,
   faster clients beat more, slower clients at equal load.

4. **Shared-room collab is the steepest cost** — every write fans out to all N
   members' sync streams, so cost is ~O(writes × members). Doubling members
   (25→50) roughly doubled both send and propagation latency. A 25-editor live
   table already shows ~2 s median (p95 ~6 s) propagation; 50 editors ~4 s
   median (p95 ~10 s).

These are **sustained, adversarial** rates (every user editing 0.5–1×/s for
25–30 s). Real editing is bursty/sparse and the app batches multi-cell ops into
one event, so day-to-day headroom is larger than the raw numbers suggest.

## Recommendations (priority order)

1. **Run Synapse with workers.** The single monolith process is the wall.
   Synchrotron/sync workers parallelize exactly the fan-out that makes collab
   slow; an event-persister + client-reader split lifts the write ceiling. This
   is the standard horizontal-scaling path and the highest-leverage fix.
2. **Bump the box to ≥4 vCPU.** Removes any client/Synapse contention and gives
   workers cores to use. (Alone, without workers, it won't lift the single-room
   serialization much — pair it with #1.)
3. **Check the DB round-trip.** ~50–85 ms per event even single-threaded; some
   is the hop to the DO-managed Postgres. Verify Postgres isn't the per-event
   floor; a closer/faster tier could cut it.
4. **Tune `rc_message` deliberately.** Stock 0.2/s burst 10 per user is harsh
   for a collaborative app (a burst of edits 429s fast — see the rate-limit
   memory), but the server can't sustain >~20/s aggregate anyway, so set
   per-user limits to balance UX against that ceiling (e.g. ~1/s burst 30), not
   to infinity.
5. **App-level:** keep batching cell updates; debounce rapid edits client-side;
   for very large shared tables consider capping simultaneous editors.

### Caveats

- Numbers are for **this** hardware (1× 2-vCPU droplet, managed PG).
- Collab latencies partly reflect send-side saturation (server already pegged).
- Rate limits were relaxed during the test and **restored** afterward; the
  `loadtestN` accounts were torn down.

---

## Update — Synapse workers, measured (2026-06-30, still 2 vCPU)

Workers were built (redis + 2 generic sync workers, nginx routing reads to them
— `infra/`, PR #116) and re-tested on the **same 2-vCPU box**. They **help even
without a resize**, once `/sync` is actually routed to them:

| Collaborative editing | Monolith | **Workers (via nginx)** |
|---|---|---|
| 25 in a room — propagation p95 | 6079 ms | **1642 ms** |
| 25 — combined Synapse CPU | 120% (1.2 cores) | **164%** |
| 50 in a room — throughput | 5.3/s | **14.1/s** |
| 50 — propagation p95 | 10110 ms | **8541 ms** |
| 50 — combined Synapse CPU | 120% | **188%** |

(Workers runs were driven off-box, so they *carry* extra RTT and still won — the
real gain is larger.)

**Why a win on only 2 cores:** the monolith is **single-threaded** (one
GIL-bound reactor), capped ~1.2 cores — ~0.8 core sat idle/unusable. The worker
processes use that idle core, running the sync fan-out in parallel with main's
writes (combined CPU 120% → 164–188%). **Writes still go to main, so the ~20/s
write ceiling is unchanged** — workers help the read/sync/collab path only.

**How to drive the workers** (`loadtest-collab-nginx.sh`): capacity mode never
calls `/sync`, so only **collab** exercises workers, and it must go **through
nginx** (`HOMESERVER=https://…`, not `:8008` — the `:8008` runner bypasses nginx
so workers sit idle). DO-droplet **hairpin NAT** can't drive the concurrent
collab setup on-box; drive from an off-box machine. Managed PG caps at **25
connections**, so `cp_max` is shrunk to fit main + workers + MAS — a real worker
fleet needs a bigger PG plan or PgBouncer.

**Next:** resize to ≥4 vCPU (operator action in DO) to add more sync workers and
scale further; a dedicated event-persister stream-writer would lift the *write*
ceiling too.
