/**
 * The SharedWorker's brain, factored out of the worker entry point so it can be
 * unit-tested against a fake wasm module (a real SharedWorker is not reachable
 * from jsdom). `matrixWorker.ts` is then just port plumbing.
 *
 * Two invariants carry the whole fix (issue 87bf86a6):
 *
 *  1. AT MOST ONE MatrixSession PER ACCOUNT, ever — including while one is
 *     still being built. Without the in-flight sharing, two tabs opening at the
 *     same moment both miss the "already exists" check and build two clients
 *     over one crypto store, which is exactly the bug.
 *  2. AT MOST ONE ConnectedWorkspace PER ROOM, with one sync loop and one send
 *     queue. The second tab's writes reach the server because they enter the
 *     queue of the client that owns the sync stream.
 *
 * Handles are never released when the last interested tab leaves. Re-opening a
 * workspace costs a history gather, tabs come and go constantly, and the worker
 * dies on its own once every tab is gone — so holding them is both cheaper and
 * simpler than refcounting. (A worker kept alive by ONE long-lived tab with many
 * visited rooms is the case to revisit if memory ever becomes a problem.)
 */

import { loadSnapshot, saveSnapshot } from '../lib/snapshotStore'
import { loadOutbox, saveOutbox, clearOutbox } from '../lib/outboxStore'
import {
  SESSION_METHODS,
  SESSION_STATIC_METHODS,
  SESSION_FACTORY_ARITY,
  WORKSPACE_METHODS,
  WORKSPACE_WRITE_METHODS,
  VERIFICATION_METHODS,
  verifyKey,
  type Cloneable,
  type Event,
  type PingInfo,
  type Request,
  type Response,
  type SessionInfo,
  type WorkspaceState,
} from './protocol'
import { wasmHeapMiB } from '../wasm/loader'

/**
 * Render an error, and say how big the wasm heap was if the module trapped.
 *
 * `RuntimeError: unreachable executed` is what BOTH a Rust panic and a failed
 * allocation look like from JS, and the difference decides where to look. A
 * panic prints a message and a source location alongside it; the allocation
 * handler traps directly, printing nothing at all. So a bare trap on a heap
 * sitting at the cap is out-of-memory — which is what the production crash
 * turned out to be — and a bare trap well below it means the panic hook is not
 * reaching us and the search is somewhere else entirely.
 */
function describeErr(err: unknown): string {
  const text = String(err)
  if (!text.includes('unreachable')) return text
  const heap = wasmHeapMiB()
  return heap === null ? text : `${text} — wasm heap ${heap}`
}

/** What the dispatcher needs from its host: a wasm module and a way to reach
 *  every connected tab. */
export interface DispatchDeps {
  /** Resolves the initialized wasm module (`getWasmModule` in production). */
  loadWasm: () => Promise<any>
  /** Send an event to every connected port. */
  broadcast: (event: Event) => void
}

/**
 * One connected tab, from the dispatcher's point of view. Requests carry their
 * origin because `workspace-state` pushes are per-tab: tabs subscribe to
 * different tables, and the bundle carries plaintext, so it goes to the ports
 * that asked rather than to everyone.
 */
export interface Client {
  /** Send one message to this tab. Returns false if the tab is gone. */
  send: (event: Event) => boolean
}

interface SessionEntry {
  ms: any
  /** ConnectedWorkspace per room id. */
  workspaces: Map<string, any>
  /** Guards the once-only session-level sync loop. */
  sessionSyncStarted: boolean
}

/**
 * How long after a change the snapshot is rewritten. Snapshot freshness is not a
 * correctness property — a marker-bounded gather fills any gap — so this is
 * debounced rather than immediate, unlike the outbox.
 */
const SNAPSHOT_DEBOUNCE_MS = 2_000
/** Backstop for changes the debounce misses (a long run of steady edits). */
const SNAPSHOT_INTERVAL_MS = 30_000

/** Per-workspace persistence, owned here rather than by any tab. */
interface Persistence {
  roomId: string
  cws: any
  key?: CryptoKey
  snapshotTimer?: ReturnType<typeof setTimeout>
  snapshotInterval?: ReturnType<typeof setInterval>
  /** Last outbox JSON written, so an unchanged queue costs nothing. */
  lastOutbox?: string
}

export interface Dispatcher {
  /** Handle one request. Never rejects — failures come back as an ErrResponse
   *  so a tab can't be left waiting on a promise that silently died. `client`
   *  identifies the asking tab; omit it only where no push can result. */
  handle(req: Request, client?: Client): Promise<Response | null>
  /** Forget a disconnected tab's subscriptions. */
  disconnect(client: Client): void
  /**
   * Every tab is gone. Flush snapshot and outbox now, because the browser is
   * free to terminate this worker the moment its last port closes — and with it
   * the send queue. Best-effort by nature: an async IndexedDB write started here
   * may not finish. The per-change outbox write is what makes durability not
   * depend on this.
   */
  flushPersistence(): void
  /** Test/diagnostic view of what the worker currently owns. */
  inspect(): { sessions: string[]; rooms: string[]; subscribers: number }
}

export function createDispatcher(deps: DispatchDeps): Dispatcher {
  const sessions = new Map<string, SessionEntry>()
  /** In-flight `session.create` per expected MXID — invariant 1. */
  const pendingSessions = new Map<string, Promise<SessionInfo>>()
  /** In-flight `workspace.open` per `userId|roomId` — invariant 2. */
  const pendingWorkspaces = new Map<string, Promise<void>>()
  const verifications = new Map<string, any>()
  /**
   * The build id of the bundle that STARTED this worker — reported by the first
   * tab to ping. The worker deliberately does not read `__BUILD_ID__` itself:
   * Vite's `define` replacement does not reach a dev-server-served worker module,
   * so referencing it there is a ReferenceError that kills the worker before it
   * can answer anything (found exactly that way). Taking the id from the first
   * tab is also the truer definition — the worker IS whichever bundle spawned it.
   */
  let build: string | null = null

  /** Which tables each tab is looking at, per room. */
  const subscriptions = new Map<Client, Map<string, string[]>>()

  const log = (level: 'log' | 'warn' | 'error', message: string) =>
    deps.broadcast({ kind: 'event', event: 'log', level, message })

  // ── Materialized state (option b) ──────────────────────────────────────────

  /** Look up an open workspace without throwing. */
  function findWorkspace(roomId: string): any {
    for (const entry of sessions.values()) {
      const ws = entry.workspaces.get(roomId)
      if (ws) return ws
    }
    return undefined
  }

  /** Call a read method, tolerating bindings that predate it. A read that throws
   *  must not take the whole bundle down with it — the rest of the state is still
   *  worth pushing, and a missing field is visible to the tab as `undefined`. */
  function read<T>(ws: any, method: string, args: unknown[], fallback: T): T {
    try {
      if (typeof ws[method] !== 'function') return fallback
      return ws[method](...args) as T
    } catch (err) {
      log('warn', `${method} failed while materializing state: ${describeErr(err)}`)
      return fallback
    }
  }

  /** Parse a JSON array of id strings, tolerating anything unexpected. */
  function parseIds(json: string): string[] {
    try {
      const parsed = JSON.parse(json)
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  }

  /**
   * Read the whole materialized bundle out of the worker's workspace. Rows are
   * limited to `tableIds` (the union of what the subscribed tabs are looking at)
   * because they are the only part that scales with the data; everything else is
   * per-table metadata and is pushed whole so a tab can render a sidebar, a view
   * picker or a filter against a table it has not opened.
   */
  function materialize(ws: any, tableIds: string[]): WorkspaceState {
    const tables = read(ws, 'listTables', [], '[]')
    // Both `listTables` and `listViewsForTable` return arrays of ID STRINGS, not
    // objects — worth stating because assuming `{id}` objects here silently
    // produced an empty schema/view map, with no error anywhere.
    const tableIdList = parseIds(tables)

    const schemas: Record<string, string> = {}
    const viewsByTable: Record<string, string> = {}
    const views: Record<string, string> = {}
    for (const tableId of tableIdList) {
      schemas[tableId] = read(ws, 'getTableSchema', [tableId], '')
      const viewList = read(ws, 'listViewsForTable', [tableId], '[]')
      viewsByTable[tableId] = viewList
      for (const viewId of parseIds(viewList)) {
        views[viewId] = read(ws, 'getView', [viewId], '')
      }
    }

    const rows: Record<string, string> = {}
    const rowOrderKeys: Record<string, string> = {}
    for (const tableId of new Set(tableIds)) {
      rows[tableId] = read(ws, 'getTableRows', [tableId], '[]')
      rowOrderKeys[tableId] = read(ws, 'getRowOrderKeys', [tableId], '{}')
    }

    return {
      tables,
      tableOrderKeys: read(ws, 'getTableOrderKeys', [], '{}'),
      currentUserId: read<string | undefined>(ws, 'currentUserId', [], undefined) ?? undefined,
      isEncrypted: read(ws, 'isEncrypted', [], false),
      undecryptableCount: read(ws, 'undecryptableCount', [], 0),
      connectionHealth: read(ws, 'connectionHealth', [], '{}'),
      rejectedWrites: read(ws, 'rejectedWrites', [], '{}'),
      pendingUpdates: read(ws, 'pendingUpdates', [], '[]'),
      schemas,
      viewsByTable,
      views,
      rows,
      rowOrderKeys,
    }
  }

  /**
   * Push fresh state for `roomId` to every tab subscribed to it. Called on the
   * sync callback AND right after a write, so a sibling tab reflects the write
   * without waiting for the homeserver echo.
   *
   * The bundle is materialized ONCE per distinct row-set rather than per tab:
   * tabs looking at the same table (the common case) share the work, and
   * `getTableRows` on a large table is the expensive part.
   */
  function pushState(roomId: string) {
    const ws = findWorkspace(roomId)
    if (!ws) return
    const byTableSet = new Map<string, Client[]>()
    for (const [client, rooms] of subscriptions) {
      const tableIds = rooms.get(roomId)
      if (!tableIds) continue
      const key = [...new Set(tableIds)].sort().join(' ')
      const clients = byTableSet.get(key)
      if (clients) clients.push(client)
      else byTableSet.set(key, [client])
    }
    for (const [key, clients] of byTableSet) {
      const tableIds = key === '' ? [] : key.split(' ')
      const state = JSON.stringify(materialize(ws, tableIds))
      for (const client of clients) {
        if (!client.send({ kind: 'event', event: 'workspace-state', roomId, state })) {
          subscriptions.delete(client) // the tab is gone
        }
      }
    }
  }

  // ── Handle registry ────────────────────────────────────────────────────────

  /** Resolve a handle key to its object and the allowlist that governs it. */
  function resolveTarget(target: string): { obj: any; allowed: Set<string> } {
    const sep = target.indexOf(':')
    const kind = sep < 0 ? target : target.slice(0, sep)
    const id = target.slice(sep + 1)
    switch (kind) {
      case 'session': {
        const entry = sessions.get(id)
        if (!entry) throw new Error(`No session for ${id} — sign in again`)
        return { obj: entry.ms, allowed: SESSION_METHODS }
      }
      case 'room': {
        for (const entry of sessions.values()) {
          const ws = entry.workspaces.get(id)
          if (ws) return { obj: ws, allowed: WORKSPACE_METHODS }
        }
        throw new Error(`Workspace ${id} is not open`)
      }
      case 'verify': {
        const v = verifications.get(id)
        if (!v) throw new Error(`No verification flow ${id}`)
        return { obj: v, allowed: VERIFICATION_METHODS }
      }
      default:
        throw new Error(`Unknown handle "${target}"`)
    }
  }

  /**
   * Normalize a wasm return value to something structured-clone can carry.
   * The bridges return only strings, numbers, booleans, `Option<String>` and
   * `Vec<u8>`, so this is a narrow guard rather than a serializer — its job is
   * to turn an accidental object return into a loud error instead of a
   * DataCloneError raised from inside `postMessage`, where the request id is
   * already gone and the caller would hang forever.
   */
  function toCloneable(value: unknown, what: string): Cloneable {
    if (value === undefined || value === null) return undefined
    const t = typeof value
    if (t === 'string' || t === 'number' || t === 'boolean') return value as Cloneable
    if (value instanceof Uint8Array) return value
    throw new Error(`${what} returned a non-transferable ${t} — it needs an explicit shape`)
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  /** Snapshot a live session for the tab that asked. */
  function describe(ms: any, joined: boolean): SessionInfo {
    const userId: string = ms.userId() ?? ''
    if (!userId) throw new Error('Session has no user id — restore did not complete')
    return { userId, sessionData: ms.sessionData(), joined }
  }

  /** Install a freshly built session: wire token persistence, register it, and
   *  retire any previous session for the same account. */
  function install(ms: any): SessionInfo {
    const info = describe(ms, false)
    const previous = sessions.get(info.userId)
    if (previous && previous.ms !== ms) {
      // A fresh sign-in for an account the worker already held (e.g. a re-key to
      // an encrypted store, which logs in again as a new device). The old client
      // is now the wrong one — retire it and tell sibling tabs to re-establish
      // rather than keep calling into it.
      log('warn', `replacing the existing session for ${info.userId}`)
      deps.broadcast({ kind: 'event', event: 'session-dropped', userId: info.userId })
    }
    sessions.set(info.userId, { ms, workspaces: new Map(), sessionSyncStarted: false })

    // MAS access tokens are short-lived: the SDK refreshes them in memory, and
    // only the tab can persist the result (localStorage is tab-only).
    if (typeof ms.startTokenPersistence === 'function') {
      ms.startTokenPersistence((sessionData: string) =>
        deps.broadcast({
          kind: 'event',
          event: 'token-refresh',
          userId: info.userId,
          sessionData,
        }),
      )
    }
    return info
  }

  async function createSession(req: Extract<Request, { kind: 'session.create' }>): Promise<SessionInfo> {
    const arity = SESSION_FACTORY_ARITY[req.via]
    if (!arity) throw new Error(`Unknown session factory "${req.via}"`)
    if (req.args.length < arity.min || req.args.length > arity.max) {
      throw new Error(
        `session.create(${req.via}) takes ${arity.min}–${arity.max} args, got ${req.args.length}`,
      )
    }

    // Already built, by this tab or another one. THIS is the second tab's happy
    // path: it gets the first tab's client instead of a rival over the same store.
    const expected = req.expectUserId
    if (expected) {
      const existing = sessions.get(expected)
      if (existing) {
        log('log', `joining the existing session for ${expected}`)
        return describe(existing.ms, true)
      }
      const inFlight = pendingSessions.get(expected)
      if (inFlight) {
        log('log', `awaiting an in-flight restore for ${expected}`)
        return { ...(await inFlight), joined: true }
      }
    }

    const build = (async () => {
      const wasm = await deps.loadWasm()
      const ms = await wasm.MatrixSession[req.via](...req.args)
      const info = install(ms)
      if (expected && info.userId !== expected) {
        log('warn', `session.create expected ${expected} but got ${info.userId}`)
      }
      return info
    })()

    if (expected) {
      pendingSessions.set(expected, build)
      try {
        return await build
      } finally {
        pendingSessions.delete(expected)
      }
    }
    return await build
  }

  function destroySession(userId: string) {
    const entry = sessions.get(userId)
    if (!entry) return
    sessions.delete(userId)
    // The wasm side owns no stoppable loop handles today (sync loops live in
    // spawned tasks and end with the worker), so dropping our references is all
    // we can do. Tabs are told so they stop calling into it.
    deps.broadcast({ kind: 'event', event: 'session-dropped', userId })
  }

  // ── Persistence (snapshot + outbox), owned here ────────────────────────────
  //
  // This lives in the worker because the worker owns the send queue, and a queue
  // whose durable copy is written from somewhere else is a race waiting to
  // happen. It was: the bridge's queue callback fires inside the write, before
  // the state push carrying the new queue, so a tab mirroring on that event
  // persisted a queue that predated the enqueue. A reload — which destroys the
  // worker and its queue — then lost the write. Writing it here, at the moment
  // the queue changes, in the context that changed it, removes the window
  // rather than narrowing it.
  //
  // It also fixes a second-order problem nobody had hit yet: with N tabs open,
  // N mirrors were writing the same outbox record.

  const persistence = new Map<string, Persistence>()

  /** Write the outbox now. Called on every queue change — no debounce, because
   *  an unsent write is exactly what must survive an unexpected termination. */
  function persistOutbox(p: Persistence) {
    let json: string
    try {
      json = p.cws.pendingUpdates()
    } catch (err) {
      log('warn', `pendingUpdates failed while mirroring the outbox: ${describeErr(err)}`)
      return
    }
    if (json === p.lastOutbox) return
    p.lastOutbox = json
    void saveOutbox(p.roomId, json, p.key)
  }

  function persistSnapshot(p: Persistence) {
    try {
      const snap = p.cws.snapshot()
      if (snap) void saveSnapshot(p.roomId, snap, p.key)
    } catch (err) {
      log('warn', `snapshot failed: ${describeErr(err)}`)
    }
  }

  /** Note a change; the snapshot write is debounced behind it. */
  function scheduleSnapshot(p: Persistence) {
    if (p.snapshotTimer) clearTimeout(p.snapshotTimer)
    p.snapshotTimer = setTimeout(() => {
      p.snapshotTimer = undefined
      persistSnapshot(p)
    }, SNAPSHOT_DEBOUNCE_MS)
  }

  // ── Workspaces ─────────────────────────────────────────────────────────────

  async function openWorkspace(req: Extract<Request, { kind: 'workspace.open' }>): Promise<void> {
    const entry = sessions.get(req.userId)
    if (!entry) throw new Error(`No session for ${req.userId} — sign in again`)
    if (entry.workspaces.has(req.roomId)) {
      log('log', `joining the open workspace ${req.roomId}`)
      return
    }
    const key = `${req.userId}|${req.roomId}`
    const inFlight = pendingWorkspaces.get(key)
    if (inFlight) return await inFlight

    const build = (async () => {
      const wasm = await deps.loadWasm()
      // The worker reads its own snapshot: it is the one that will keep it
      // current, and a tab handing one over could only ever pass a copy it read
      // through this same store.
      const snapshotJson = await loadSnapshot(req.roomId, req.snapshotKey)
      const cws = await wasm.ConnectedWorkspace.create(entry.ms, req.roomId, snapshotJson)

      const p: Persistence = { roomId: req.roomId, cws, key: req.snapshotKey }
      persistence.set(req.roomId, p)

      // The two callbacks that used to be tab closures. They fire on the
      // worker's single client, so every tab hears about every change —
      // including the changes a sibling tab wrote.
      cws.startSync(() => {
        deps.broadcast({ kind: 'event', event: 'workspace-change', roomId: req.roomId })
        pushState(req.roomId)
        scheduleSnapshot(p)
      })
      if (typeof cws.onQueueChanged === 'function') {
        cws.onQueueChanged(() => {
          // Durable FIRST, notify second: the tabs only need to know, whereas an
          // unsent write needs to exist somewhere the worker's death cannot reach.
          persistOutbox(p)
          deps.broadcast({ kind: 'event', event: 'queue-change', roomId: req.roomId })
        })
      }
      p.snapshotInterval = setInterval(() => persistSnapshot(p), SNAPSHOT_INTERVAL_MS)

      // Replay a persisted outbox BEFORE any tab can write (ADR 0003 phase 1):
      // unsent writes from a previous worker re-apply under LWW — carrying their
      // original HLC timestamps, so a since-superseded write loses fairly — and
      // re-enter the send queue.
      try {
        const saved = await loadOutbox(req.roomId, req.snapshotKey)
        if (saved && typeof cws.restorePendingUpdates === 'function') {
          const replayed = cws.restorePendingUpdates(saved)
          if (replayed > 0) log('log', `replayed ${replayed} unsent write(s) for ${req.roomId}`)
        }
        void clearOutbox(req.roomId)
      } catch (err) {
        log('warn', `outbox replay failed: ${err}`)
      }

      // Persist the freshly-gathered state at once, so a quick reload already
      // benefits from a snapshot.
      persistSnapshot(p)
      // Registered last, so `room:` only ever resolves to a fully wired
      // workspace (the sync callbacks above fire later, by which time this ran).
      entry.workspaces.set(req.roomId, cws)
    })()

    pendingWorkspaces.set(key, build)
    try {
      await build
    } finally {
      pendingWorkspaces.delete(key)
    }
  }

  /** Rooms with a state push already scheduled. */
  const queuedPushes = new Set<string>()

  /**
   * Push state for a room after the current request has been answered.
   *
   * `setTimeout` rather than a microtask on purpose: the response is posted from
   * the same microtask chain that called this, so a promise-scheduled push would
   * overtake it and hand a tab state for a subscription it does not yet know
   * succeeded. Coalescing on `roomId` also collapses a burst into one push.
   */
  function queueStateFor(roomId: string) {
    if (queuedPushes.has(roomId)) return
    queuedPushes.add(roomId)
    setTimeout(() => {
      queuedPushes.delete(roomId)
      pushState(roomId)
    }, 0)
  }

  // ── Request dispatch ───────────────────────────────────────────────────────

  async function run(req: Request, client?: Client): Promise<Cloneable> {
    switch (req.kind) {
      case 'ping': {
        if (build === null) build = req.build
        const info: PingInfo = {
          build,
          match: req.build === build,
          sessions: [...sessions.keys()],
        }
        return JSON.stringify(info)
      }

      case 'session.create':
        return JSON.stringify(await createSession(req))

      case 'session.static': {
        if (!SESSION_STATIC_METHODS.has(req.method)) {
          throw new Error(`MatrixSession.${req.method} is not callable from a tab`)
        }
        const wasm = await deps.loadWasm()
        return toCloneable(
          await wasm.MatrixSession[req.method](...req.args),
          `MatrixSession.${req.method}`,
        )
      }

      case 'session.destroy':
        destroySession(req.userId)
        return undefined

      case 'workspace.open':
        await openWorkspace(req)
        return undefined

      case 'workspace.subscribe': {
        if (!client) throw new Error('workspace.subscribe needs a connected tab')
        if (!findWorkspace(req.roomId)) throw new Error(`Workspace ${req.roomId} is not open`)
        let rooms = subscriptions.get(client)
        if (!rooms) {
          rooms = new Map()
          subscriptions.set(client, rooms)
        }
        rooms.set(req.roomId, req.tableIds)
        // Answer the subscribe FIRST, then push: a tab that awaited the request
        // is ready for state by the time it lands, and one that already had state
        // is not handed a bundle it will discard.
        queueStateFor(req.roomId)
        return undefined
      }

      case 'verification.acquire': {
        const entry = sessions.get(req.userId)
        if (!entry) throw new Error(`No session for ${req.userId} — sign in again`)
        const handle = await entry.ms.verificationForFlow(req.flowId)
        if (!handle) return undefined
        verifications.set(req.flowId, handle)
        return verifyKey(req.flowId)
      }

      case 'call': {
        // `startSessionSync` takes a callback, so it can't go through the
        // generic path — install it here (once) with a broadcasting one.
        if (req.method === 'startSessionSync') {
          const userId = req.target.slice('session:'.length)
          const entry = sessions.get(userId)
          if (!entry) throw new Error(`No session for ${userId} — sign in again`)
          if (!entry.sessionSyncStarted) {
            entry.sessionSyncStarted = true
            entry.ms.startSessionSync(() =>
              deps.broadcast({ kind: 'event', event: 'session-sync', userId }),
            )
          }
          return undefined
        }
        const { obj, allowed } = resolveTarget(req.target)
        if (!allowed.has(req.method) || typeof obj[req.method] !== 'function') {
          throw new Error(`${req.target}.${req.method} is not callable from a tab`)
        }
        const result = toCloneable(await obj[req.method](...req.args), `${req.target}.${req.method}`)
        // A write changes what every subscribed tab should be showing. Pushing
        // now (rather than waiting for the homeserver echo) is what makes a
        // sibling tab's edit appear immediately.
        //
        // Pushed SYNCHRONOUSLY, before this response goes out, which matters more
        // than it looks: port messages arrive in send order, so the writing tab
        // applies the new state and only then sees its write resolve. That is the
        // invariant callers assume — `Sidebar.handleCreateTable` awaits
        // `createTable` and immediately reads the new table's schema. With the
        // push deferred, that read raced and lost: it threw "Table not found" and
        // the navigation never happened. Chromium's timing hid it; Firefox did
        // not. (Deferring is still right for `workspace.subscribe`, where the tab
        // must learn the subscription succeeded before state arrives.)
        if (req.target.startsWith('room:') && WORKSPACE_WRITE_METHODS.has(req.method)) {
          pushState(req.target.slice('room:'.length))
        }
        return result
      }

      case 'bye':
        return undefined
    }
    throw new Error(`Unknown request "${(req as { kind: string }).kind}"`)
  }

  return {
    async handle(req, client) {
      if (req.kind === 'bye') return null
      try {
        return { kind: 'response', id: req.id, ok: true, value: await run(req, client) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Worth logging in the tab as well as answering: a rejected request is
        // often the first visible symptom of a worker-side problem, and the
        // worker's own console is not reachable from a bug report.
        log('warn', `${req.kind} failed: ${message}`)
        return { kind: 'response', id: req.id, ok: false, error: message }
      }
    },
    disconnect(client) {
      subscriptions.delete(client)
    },
    flushPersistence() {
      for (const p of persistence.values()) {
        if (p.snapshotTimer) {
          clearTimeout(p.snapshotTimer)
          p.snapshotTimer = undefined
        }
        persistOutbox(p)
        persistSnapshot(p)
      }
    },
    inspect() {
      const rooms: string[] = []
      for (const entry of sessions.values()) rooms.push(...entry.workspaces.keys())
      return { sessions: [...sessions.keys()], rooms, subscribers: subscriptions.size }
    },
  }
}
