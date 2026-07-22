# ADR 0003 — Optimistic ↔ LWW reconciliation: persistent outbox + write lock

- **Status:** Accepted
- **Date:** 2026-07-22
- **Context refs:** `ARCHITECTURE_REVIEW.md` §4.1 (HLC fix — the clock layer
  below this), backlog issue `399d63e1`, the interim offline guard (#2,
  `OfflineOverlay`), incremental cold start (issue `6f092cf4`,
  `snapshotStore`), at-rest encryption (issue `c72ec5df`).

## Context

Cell writes are optimistic: `ConnectedWorkspace::updateCell` applies to the
local workspace immediately, then *enqueues* the update in an in-memory,
debounced, coalescing send queue (`flush_pending`). The LWW clock itself is
sound since the §4.1 fix (hybrid logical clock, `origin_server_ts`
tiebreaker): concurrent and even offline edits *converge correctly*. What is
not sound is the seam between the optimistic apply and the write's eventual
fate. Three failure modes:

1. **Silent loss of never-sent writes.** The send queue is in-memory and its
   errors are deliberately swallowed. Close the tab during an outage and the
   local state shows a value that never reached the room; the next cold start
   silently drops it. The interim `OfflineOverlay` exists precisely because
   of this — but it only triggers on `navigator.onLine`, never when the
   network is up and the homeserver is unresponsive.
2. **Permanent rejections retry forever.** `send_batch` fails closed on an
   unencrypted room, and can fail on permissions or a dead session. Those
   re-queue identically, retry with backoff to infinity, and never surface —
   `updateCell` resolves before any send happens, so the UI's per-call error
   path can't fire.
3. **Legitimate LWW loss is indistinguishable from the bugs above.** A
   concurrent writer's later timestamp correctly wins and the cell flips
   under the user, silently.

## Decision

**Bound divergence instead of reconciling it.** Offline reconciliation is
already *correct* under HLC+LWW; the risk is the social surprise of a large
stale batch landing on cells teammates have since edited. For a
collaboration-first product we prefer to prevent extensive offline editing
rather than build UX for merging it:

1. **Persistent outbox (phase 1).** The pending send queue is mirrored to
   IndexedDB per workspace (encrypted with the at-rest `snapshotKey`, like
   snapshots — outbox entries hold decrypted cell data). On cold start the
   saved outbox is replayed through the normal apply+enqueue path *before*
   the user edits: replayed writes re-apply under LWW (a superseded write
   loses fairly — its HLC timestamp is old) and re-enter the send queue.
   Send-success removes entries; the mirror tracks the live queue on every
   enqueue and drain.
2. **Write lock on connection loss (phase 2).** The bridge exposes send/sync
   health. After ~20–30 s of consecutive send failures or a stalled sync
   loop, the app locks writes behind the (softened) disconnected overlay —
   "reconnecting, retrying…", auto-clearing on the first success. Because
   writes lock quickly, the outbox stays small by construction; it only has
   to bridge seconds-to-a-minute of flakiness, not days of divergence. The
   `navigator.onLine` trigger remains as a fast path.
3. **Failure classification (phase 3).** Retryable failures (rate limit,
   network, server 5xx) keep the retry/backoff behavior. Permanent
   rejections (forbidden, unencrypted room, room gone) are dropped from the
   outbox, the affected cells are reverted to converged state (recomputed
   from history), and the failure is surfaced. Send-success is the ack — no
   echo-ack via /sync; Matrix's send response is authoritative enough, and
   echo tracking buys machinery for a failure class the protocol effectively
   doesn't have.
4. **Conflict-loss UX.** A remote write overwriting a recently-edited cell
   gets a light indication (brief cell highlight), no modal; the history
   drawer is the recovery path. CRDT convergence stays silent by default.

## Consequences

- A closed tab can no longer lose acknowledged-looking edits: they are on
  disk and replay on the next start (phase 1 kills failure mode 1).
- The disconnected overlay stops being a data-loss warning and becomes a
  status: reload while disconnected is safe once the outbox persists.
- Stale outbox replays may emit already-superseded events; LWW discards them
  on read and the coalescing queue keeps the noise to one event per cell.
- The native CLI is unaffected: it sends synchronously (`send_cell_batch`
  awaited) and has no optimistic seam.
