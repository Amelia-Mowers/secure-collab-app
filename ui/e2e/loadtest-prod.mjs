/**
 * Production load-test driver for TideWork's Synapse homeserver.
 *
 * Drives REAL load against https://matrix.tidework.io using many pre-provisioned
 * accounts whose mas-cli compatibility tokens are supplied up front (this script
 * does NOT log in). Two modes:
 *
 *   capacity — each account creates its own room and sends cell-update events at
 *              a target per-account rate; measures send latency + 429 throttling
 *              where Synapse's rc_message limits bite (per-user, parallel users).
 *   collab   — all accounts share ONE room; each account both WRITES cell updates
 *              and READS via /sync, measuring end-to-end propagation latency
 *              (write on account A → visible to account B's sync).
 *
 * No external deps, no Playwright — Node 18+ built-ins only (global fetch,
 * performance.now, setTimeout). Bounded by a wall-clock deadline; clears all
 * timers and process.exit(0) at the end so an open long-poll /sync can't hang it.
 *
 * Inputs:
 *   env LOADTEST_ACCOUNTS  path to JSON [{username, token, device}, …]
 *                          (default ui/e2e/loadtest-accounts.json)
 *   env HOMESERVER         default https://matrix.tidework.io
 *   --mode capacity|collab (required)
 *   --accounts N           how many of the file's accounts to use (default all)
 *   --rate R               events/sec PER account (default 1)
 *   --duration D           seconds of load (default 30)
 *   --room ROOM_ID         collab only: reuse an existing shared room
 *
 * Example (run in the Nix dev shell, from ui/):
 *   node e2e/loadtest-prod.mjs --mode capacity --accounts 10 --rate 1 --duration 30
 *   node e2e/loadtest-prod.mjs --mode collab   --accounts 10 --rate 0.5 --duration 60
 */
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Config / args
// ---------------------------------------------------------------------------

const HOMESERVER = (process.env.HOMESERVER ?? 'https://matrix.tidework.io').replace(/\/$/, '')
const ACCOUNTS_PATH = process.env.LOADTEST_ACCOUNTS ?? 'ui/e2e/loadtest-accounts.json'
const SERVER_NAME = 'tidework.io'
const GRACE_MS = 5_000 // collab: keep reading this long after writes stop

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++ }
      else out[key] = true
    }
  }
  return out
}

const args = parseArgs(process.argv)
const MODE = args.mode
const RATE = Number(args.rate ?? 1)
const DURATION = Number(args.duration ?? 30)
const SHARED_ROOM_ARG = typeof args.room === 'string' ? args.room : null

if (MODE !== 'capacity' && MODE !== 'collab') {
  console.error('--mode capacity|collab is required')
  process.exit(2)
}
if (!(RATE > 0) || !(DURATION > 0)) {
  console.error('--rate and --duration must be positive numbers')
  process.exit(2)
}

let accountsFile
try {
  accountsFile = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf8'))
} catch (err) {
  console.error(`failed to read accounts file ${ACCOUNTS_PATH}: ${err.message}`)
  process.exit(2)
}
if (!Array.isArray(accountsFile) || accountsFile.length === 0) {
  console.error(`accounts file ${ACCOUNTS_PATH} must be a non-empty JSON array`)
  process.exit(2)
}

const requested = args.accounts === undefined ? accountsFile.length : Number(args.accounts)
if (!(requested > 0)) { console.error('--accounts must be a positive number'); process.exit(2) }
const N = Math.min(requested, accountsFile.length)
if (requested > accountsFile.length) {
  console.log(`note: --accounts ${requested} exceeds file (${accountsFile.length}); using ${N}`)
}
const accounts = accountsFile.slice(0, N).map((a) => ({
  username: a.username,
  token: a.token,
  device: a.device,
  userId: `@${a.username}:${SERVER_NAME}`,
}))

const INTERVAL_MS = 1000 / RATE

// ---------------------------------------------------------------------------
// CS-API helpers — all take a bearer token; base = HOMESERVER. Never throw.
// ---------------------------------------------------------------------------

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

async function createRoom(token) {
  const r = await fetch(`${HOMESERVER}/_matrix/client/v3/createRoom`, {
    method: 'POST', headers: headers(token), body: JSON.stringify({ preset: 'private_chat' }),
  })
  const j = await r.json()
  return j.room_id
}

/**
 * Invite one user, retrying while the server says we are going too fast.
 *
 * Invites are rate-limited per room, per user and per issuer, and collab setup
 * is the single burstiest thing this driver does: one host inviting up to a
 * hundred accounts at once. Measured on prod at 25 accounts with stock limits,
 * 15 of 24 invites came back 429 — and because the caller ignored the status,
 * those 15 accounts then failed to JOIN with 403 "You are not invited to this
 * room". The run reported a collapse in collaborative throughput that was
 * entirely an artefact of its own setup.
 *
 * `retry_after_ms` is the server telling us exactly how long to wait, so honour
 * it rather than guessing.
 */
async function invite(token, roomId, userId, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
      method: 'POST', headers: headers(token), body: JSON.stringify({ user_id: userId }),
    })
    if (r.status !== 429) return r.status
    let waitMs = 100
    try {
      const body = await r.json()
      if (Number.isFinite(body?.retry_after_ms)) waitMs = Math.max(body.retry_after_ms, 50)
    } catch { /* no body — fall back to the default backoff */ }
    // Grow the floor a little each time, so a server that keeps saying "too
    // fast" is not hammered at its own suggested interval forever.
    await new Promise(res => setTimeout(res, waitMs + i * 100))
  }
  return 429
}

async function joinRoom(token, roomId) {
  const r = await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
    method: 'POST', headers: headers(token), body: '{}',
  })
  return r.status
}

/** PUT a single cell-update event; measure wall-clock latency. Never throws. */
async function sendCell(token, roomId, txnId, content) {
  const t0 = performance.now()
  try {
    const r = await fetch(
      `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/io.tidework.cell.update/${txnId}`,
      { method: 'PUT', headers: headers(token), body: JSON.stringify(content) },
    )
    const latencyMs = performance.now() - t0
    let retryAfterMs = 0
    if (r.status === 429) {
      try { retryAfterMs = (await r.json()).retry_after_ms || 0 } catch {}
    } else {
      // Drain the body so the connection can be reused.
      try { await r.text() } catch {}
    }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, latencyMs, retryAfterMs }
  } catch (error) {
    return { ok: false, status: 0, latencyMs: performance.now() - t0, error: error.message }
  }
}

/**
 * Long-poll /sync. Returns { next_batch, events } where events is a flat list of
 * { sender, content } for every io.tidework.cell.update timeline event across all
 * joined rooms in the response. Never throws — on error returns the prior `since`.
 */
async function sync(token, since) {
  try {
    const u = new URL(`${HOMESERVER}/_matrix/client/v3/sync`)
    u.searchParams.set('timeout', '25000')
    if (since) u.searchParams.set('since', since)
    const r = await fetch(u, { headers: headers(token) })
    if (r.status !== 200) { try { await r.text() } catch {}; return { next_batch: since, events: [] } }
    const j = await r.json()
    const events = []
    const joined = j.rooms?.join ?? {}
    for (const roomId of Object.keys(joined)) {
      const tl = joined[roomId]?.timeline?.events ?? []
      for (const ev of tl) {
        if (ev.type === 'io.tidework.cell.update') events.push({ sender: ev.sender, content: ev.content })
      }
    }
    return { next_batch: j.next_batch ?? since, events }
  } catch {
    return { next_batch: since, events: [] }
  }
}

/** Cell content shape. `key` is a unique correlation string. */
function cellContent(n, key) {
  return {
    v: 1,
    table_id: 'lt',
    row_id: 'r' + n,
    column_id: 'c',
    value: JSON.stringify(String(n)),
    lt_key: key,
  }
}

// ---------------------------------------------------------------------------
// Small stats helpers
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

/** Summarize a list of latency numbers into {count, p50, p95, p99, max}. */
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const round = (x) => Math.round(x * 100) / 100
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.length ? sorted[sorted.length - 1] : 0),
  }
}

// Per-account monotonically increasing txn counter + random suffix.
function makeTxnFactory(prefix) {
  let n = 0
  return () => `lt-${prefix}-${++n}-${Math.random().toString(36).slice(2, 8)}`
}

// ---------------------------------------------------------------------------
// Shared collectors
// ---------------------------------------------------------------------------

const sendResults = [] // { latencyMs, status }
const propagationResults = [] // ms
const timers = new Set()

function trackTimeout(ms) {
  return new Promise((res) => {
    const t = setTimeout(() => { timers.delete(t); res() }, ms)
    timers.add(t)
  })
}
function clearAllTimers() {
  for (const t of timers) clearTimeout(t)
  timers.clear()
}

function classify(results) {
  let ok = 0, throttled = 0, errors = 0, network = 0
  for (const r of results) {
    if (r.status === 429) throttled++
    else if (r.status === 0) network++
    else if (r.status >= 200 && r.status < 300) ok++
    else errors++
  }
  return { ok, throttled, errors, network }
}

// ---------------------------------------------------------------------------
// capacity mode
// ---------------------------------------------------------------------------

async function runCapacity(endAt) {
  console.log(`==> capacity: ${N} accounts, each creating a room, sending at ~${RATE}/s`)

  async function driveAccount(acct, i) {
    // Stagger per-account start over ~1s to avoid a synchronized burst.
    await trackTimeout(Math.round(i * (1000 / N)))
    if (performance.now() >= endAt) return

    let room
    try {
      room = await createRoom(acct.token)
    } catch (err) {
      console.error(`account ${acct.username}: createRoom failed: ${err.message}`)
      return
    }
    if (!room) {
      console.error(`account ${acct.username}: createRoom returned no room_id`)
      return
    }

    const nextTxn = makeTxnFactory(i)
    let n = 0
    while (performance.now() < endAt) {
      const tickStart = performance.now()
      const key = `${i}:${n}`
      const res = await sendCell(acct.token, room, nextTxn(), cellContent(n, key))
      sendResults.push({ latencyMs: res.latencyMs, status: res.status })
      n++
      const elapsed = performance.now() - tickStart
      const wait = INTERVAL_MS - elapsed
      if (wait > 0) await trackTimeout(wait)
    }
  }

  await Promise.all(accounts.map((acct, i) => driveAccount(acct, i)))
}

// ---------------------------------------------------------------------------
// collab mode
// ---------------------------------------------------------------------------

async function setupCollabRoom() {
  if (SHARED_ROOM_ARG) {
    console.log(`==> collab: reusing room ${SHARED_ROOM_ARG}`)
    // Best-effort: everyone joins so their /sync sees the timeline.
    await Promise.all(accounts.map(async (acct) => {
      try { await joinRoom(acct.token, SHARED_ROOM_ARG) } catch {}
    }))
    return SHARED_ROOM_ARG
  }

  const host = accounts[0]
  const room = await createRoom(host.token)
  if (!room) throw new Error('account[0] createRoom returned no room_id')
  console.log(`==> collab: created shared room ${room}; inviting ${N - 1} others`)

  // account[0] invites every other account. A failed invite is FATAL, not a
  // warning: the account would go on to 403 at join, be silently absent from
  // the room, and quietly turn a collab measurement into a measurement of
  // however many accounts happened to get in. 403 (already invited/joined) and
  // 409 are fine.
  const inviteStatuses = await Promise.all(accounts.slice(1).map(async (acct) => {
    try {
      return await invite(host.token, room, acct.userId)
    } catch (err) {
      console.error(`invite ${acct.userId} threw: ${err.message}`)
      return 0
    }
  }))
  const failedInvites = inviteStatuses.filter((s) => !(s >= 200 && s < 300) && s !== 403 && s !== 409)
  if (failedInvites.length) {
    const counts = failedInvites.reduce((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {})
    throw new Error(
      `collab setup: ${failedInvites.length}/${accounts.length - 1} invites failed ` +
      `(${JSON.stringify(counts)}). Relax rc_invites (loadtest-relax-limits.sh) and ` +
      `make sure EVERY synapse process was restarted — a stale worker keeps the old limits.`,
    )
  }

  // Each other account joins. Also fatal for the same reason — a partially
  // populated room measures nothing anybody asked about.
  const joinStatuses = await Promise.all(accounts.slice(1).map(async (acct) => {
    try {
      return await joinRoom(acct.token, room)
    } catch (err) {
      console.error(`account ${acct.username}: join threw: ${err.message}`)
      return 0
    }
  }))
  const failedJoins = joinStatuses.filter((s) => !(s >= 200 && s < 300))
  if (failedJoins.length) {
    const counts = failedJoins.reduce((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {})
    throw new Error(
      `collab setup: ${failedJoins.length}/${accounts.length - 1} joins failed ` +
      `(${JSON.stringify(counts)}). A 403 here means the invite never landed.`,
    )
  }
  console.log(`==> collab: ${accounts.length} accounts in the room`)

  return room
}

/**
 * `endAt` is recomputed after setup, deliberately.
 *
 * Populating a 50-account room takes real time — fifty invites, each retrying
 * while the server rate-limits them, then fifty joins. With the clock started
 * before setup, that setup ate the entire measurement window: the 50-account
 * scenario reported 0 sends in a 30s test having spent 37s just getting
 * everyone into the room, which reads as a total collapse in collaborative
 * throughput rather than as a test that never began.
 *
 * Setup is not the thing being measured, so it does not get to consume the
 * measurement.
 */
async function runCollab(_endAt, durationMs) {
  const room = await setupCollabRoom()
  const endAt = performance.now() + durationMs
  const sentAt = new Map() // key -> performance.now()
  const seen = new Set() // `${readerUsername}|${key}` dedupe

  async function writer(acct, i) {
    await trackTimeout(Math.round(i * (1000 / N)))
    const nextTxn = makeTxnFactory(`w${i}`)
    let n = 0
    while (performance.now() < endAt) {
      const tickStart = performance.now()
      const key = `${i}:${n}`
      sentAt.set(key, performance.now())
      const res = await sendCell(acct.token, room, nextTxn(), cellContent(n, key))
      sendResults.push({ latencyMs: res.latencyMs, status: res.status })
      n++
      const elapsed = performance.now() - tickStart
      const wait = INTERVAL_MS - elapsed
      if (wait > 0) await trackTimeout(wait)
    }
  }

  async function reader(acct) {
    let since = ''
    const readUntil = endAt + GRACE_MS
    while (performance.now() < readUntil) {
      const { next_batch, events } = await sync(acct.token, since)
      since = next_batch
      const now = performance.now()
      for (const ev of events) {
        const key = ev.content?.lt_key
        if (!key) continue
        if (ev.sender === acct.userId) continue // ignore own writes
        if (!sentAt.has(key)) continue
        const dedupeKey = `${acct.username}|${key}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        propagationResults.push(now - sentAt.get(key))
      }
    }
  }

  // Writers stop at endAt; readers keep going for GRACE_MS to catch in-flight events.
  await Promise.all([
    ...accounts.map((acct, i) => writer(acct, i)),
    ...accounts.map((acct) => reader(acct)),
  ])

  return room
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== TideWork PROD LOAD TEST ===')
  console.log(JSON.stringify({
    homeserver: HOMESERVER,
    mode: MODE,
    accounts: N,
    rate_per_account: RATE,
    duration_s: DURATION,
    aggregate_target_rate: Math.round(N * RATE * 100) / 100,
    room: SHARED_ROOM_ARG ?? '(created)',
  }, null, 2))

  const startedAt = performance.now()
  const endAt = startedAt + DURATION * 1000
  let room

  if (MODE === 'capacity') {
    await runCapacity(endAt)
  } else {
    room = await runCollab(endAt, DURATION * 1000)
  }

  clearAllTimers()
  const wallSeconds = (performance.now() - startedAt) / 1000

  // ---- Compute stats ----
  const sendLatencies = sendResults.map((r) => r.latencyMs)
  const sendStats = summarize(sendLatencies)
  const counts = classify(sendResults)
  const successfulSends = counts.ok
  const throughput = Math.round((successfulSends / DURATION) * 100) / 100

  const report = {
    config: {
      mode: MODE,
      homeserver: HOMESERVER,
      accounts: N,
      rate_per_account: RATE,
      duration_s: DURATION,
      wall_s: Math.round(wallSeconds * 100) / 100,
    },
    sends: {
      total: sendResults.length,
      ok_2xx: counts.ok,
      throttled_429: counts.throttled,
      errors_non2xx: counts.errors,
      network_errors: counts.network,
      latency_ms: sendStats,
    },
    throughput: {
      successful_sends_per_s: throughput,
      aggregate_target_rate: Math.round(N * RATE * 100) / 100,
    },
  }

  if (MODE === 'collab') {
    report.collab = {
      room: room ?? SHARED_ROOM_ARG,
      propagations_measured: propagationResults.length,
      propagation_ms: summarize(propagationResults),
    }
  }

  // ---- Human-readable ----
  console.log('\n=== RESULTS ===')
  console.log(`mode=${MODE}  accounts=${N}  rate=${RATE}/s/acct  duration=${DURATION}s  wall=${report.config.wall_s}s`)
  console.log('\nSends:')
  console.log(`  total=${report.sends.total}  ok=${counts.ok}  429=${counts.throttled}  err=${counts.errors}  net-err=${counts.network}`)
  console.log(`  latency ms: p50=${sendStats.p50}  p95=${sendStats.p95}  p99=${sendStats.p99}  max=${sendStats.max}  (n=${sendStats.count})`)
  console.log('\nThroughput:')
  console.log(`  ${throughput} successful sends/s  (aggregate target ${report.throughput.aggregate_target_rate}/s)`)
  if (MODE === 'collab') {
    const p = report.collab.propagation_ms
    console.log('\nPropagation (write -> other account sync):')
    console.log(`  measured=${report.collab.propagations_measured}`)
    console.log(`  latency ms: p50=${p.p50}  p95=${p.p95}  p99=${p.p99}  max=${p.max}  (n=${p.count})`)
  }

  console.log('\nJSON:' + JSON.stringify(report))
  process.exit(0)
}

main().catch((err) => {
  console.error('LOAD TEST: FAIL —', err?.stack ?? err?.message ?? err)
  process.exit(1)
})
