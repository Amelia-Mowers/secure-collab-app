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
