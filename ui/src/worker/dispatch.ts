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

import {
  SESSION_METHODS,
  SESSION_STATIC_METHODS,
  SESSION_FACTORY_ARITY,
  WORKSPACE_METHODS,
  VERIFICATION_METHODS,
  verifyKey,
  type Cloneable,
  type Event,
  type PingInfo,
  type Request,
  type Response,
  type SessionInfo,
} from './protocol'

/** What the dispatcher needs from its host: a wasm module and a way to reach
 *  every connected tab. */
export interface DispatchDeps {
  /** Resolves the initialized wasm module (`getWasmModule` in production). */
  loadWasm: () => Promise<any>
  /** Send an event to every connected port. */
  broadcast: (event: Event) => void
}

interface SessionEntry {
  ms: any
  /** ConnectedWorkspace per room id. */
  workspaces: Map<string, any>
  /** Guards the once-only session-level sync loop. */
  sessionSyncStarted: boolean
}

export interface Dispatcher {
  /** Handle one request. Never rejects — failures come back as an ErrResponse
   *  so a tab can't be left waiting on a promise that silently died. */
  handle(req: Request): Promise<Response | null>
  /** Test/diagnostic view of what the worker currently owns. */
  inspect(): { sessions: string[]; rooms: string[] }
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

  const log = (level: 'log' | 'warn' | 'error', message: string) =>
    deps.broadcast({ kind: 'event', event: 'log', level, message })

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
      const cws = await wasm.ConnectedWorkspace.create(entry.ms, req.roomId, req.snapshotJson)

      // The two callbacks that used to be tab closures. They fire on the
      // worker's single client, so every tab hears about every change —
      // including the changes a sibling tab wrote.
      cws.startSync(() =>
        deps.broadcast({ kind: 'event', event: 'workspace-change', roomId: req.roomId }),
      )
      if (typeof cws.onQueueChanged === 'function') {
        cws.onQueueChanged(() =>
          deps.broadcast({ kind: 'event', event: 'queue-change', roomId: req.roomId }),
        )
      }
      entry.workspaces.set(req.roomId, cws)
    })()

    pendingWorkspaces.set(key, build)
    try {
      await build
    } finally {
      pendingWorkspaces.delete(key)
    }
  }

  // ── Request dispatch ───────────────────────────────────────────────────────

  async function run(req: Request): Promise<Cloneable> {
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
        return toCloneable(await obj[req.method](...req.args), `${req.target}.${req.method}`)
      }

      case 'bye':
        return undefined
    }
    throw new Error(`Unknown request "${(req as { kind: string }).kind}"`)
  }

  return {
    async handle(req) {
      if (req.kind === 'bye') return null
      try {
        return { kind: 'response', id: req.id, ok: true, value: await run(req) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Worth logging in the tab as well as answering: a rejected request is
        // often the first visible symptom of a worker-side problem, and the
        // worker's own console is not reachable from a bug report.
        log('warn', `${req.kind} failed: ${message}`)
        return { kind: 'response', id: req.id, ok: false, error: message }
      }
    },
    inspect() {
      const rooms: string[] = []
      for (const entry of sessions.values()) rooms.push(...entry.workspaces.keys())
      return { sessions: [...sessions.keys()], rooms }
    },
  }
}
