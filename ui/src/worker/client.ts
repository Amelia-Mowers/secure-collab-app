/**
 * Tab-side client for the Matrix SharedWorker (issue 87bf86a6).
 *
 * Wraps the port in promises and a small typed surface, so callers write
 * `matrix.roomCall(roomId, 'updateCell', …)` instead of hand-rolling ids. Two
 * deliberate properties:
 *
 *  - `connectWorker()` returns `null` when the browser has no SharedWorker or
 *    the worker fails to answer a ping. Callers then keep today's in-tab client.
 *    A missing worker must degrade to the current behaviour, not to a blank app.
 *
 *  - No blanket request timeout. Several calls legitimately run for minutes (a
 *    cold-start history gather, `initialSync` on a large account) and the ones
 *    that need a bound already race their own — see `restoreSession` in
 *    `useAuth.ts`. Only the connect-time ping is bounded, so an unreachable
 *    worker is detected instead of hanging the app.
 */

import {
  roomKey,
  sessionKey,
  type Cloneable,
  type Event,
  type Message,
  type PingInfo,
  type Request,
  type Response,
  type SessionInfo,
  type SessionVia,
} from './protocol'

declare const __BUILD_ID__: string

/** How long the worker gets to answer the connect-time ping before we give up
 *  on it and fall back to an in-tab client. */
const PING_TIMEOUT_MS = 10_000

export type EventHandler = (event: Event) => void

/** A request minus the id `send` assigns. Written per-member so the `Omit`
 *  distributes over the union — a plain `Omit<Request, 'id'>` collapses to the
 *  union's *common* keys and rejects every request-specific field. */
type UnsentRequest = {
  [K in Request['kind']]: Omit<Extract<Request, { kind: K }>, 'id'>
}[Request['kind']]

export interface MatrixWorkerClient {
  /** Worker build id + which accounts it already holds. */
  readonly info: PingInfo
  /** Create or JOIN the session for an account. `expectUserId` (known for a
   *  restore) lets the worker hand back an existing client without building
   *  anything — the second tab's happy path. */
  createSession(via: SessionVia, args: Cloneable[], expectUserId?: string): Promise<SessionInfo>
  /** Sign-out: drop the worker's session for this account. */
  destroySession(userId: string): Promise<void>
  /** Open or join the ConnectedWorkspace for a room, starting its sync loop. */
  openWorkspace(userId: string, roomId: string, snapshotJson?: string): Promise<void>
  /** Declare which tables this tab is looking at and start receiving
   *  `workspace-state` pushes. Replaces any previous subscription for the room. */
  subscribe(roomId: string, tableIds: string[]): Promise<void>
  /** Call a MatrixSession method. */
  sessionCall(userId: string, method: string, ...args: Cloneable[]): Promise<Cloneable>
  /** Call a ConnectedWorkspace method. */
  roomCall(roomId: string, method: string, ...args: Cloneable[]): Promise<Cloneable>
  /** Call a static MatrixSession method (OAuth discovery / start). */
  staticCall(method: string, ...args: Cloneable[]): Promise<Cloneable>
  /** Take ownership of an incoming device-verification flow; resolves to the
   *  handle key, or `undefined` if the flow is gone. */
  acquireVerification(userId: string, flowId: string): Promise<string | undefined>
  /** Call a DeviceVerification method on a handle from `acquireVerification`. */
  verificationCall(handle: string, method: string, ...args: Cloneable[]): Promise<Cloneable>
  /** Subscribe to worker events; returns an unsubscribe. */
  on(handler: EventHandler): () => void
}

let connecting: Promise<MatrixWorkerClient | null> | null = null

/**
 * Connect to the shared worker, or resolve `null` if this browser can't (no
 * SharedWorker) or the worker doesn't answer. Idempotent per tab: the connection
 * is a singleton, because a second port would not be harmful but a second
 * *client* would, and keeping one place to reason about is worth more.
 */
export function connectWorker(): Promise<MatrixWorkerClient | null> {
  if (!connecting) connecting = establish()
  return connecting
}

/** Drop the cached connection (tests, and sign-out paths that reset the app). */
export function resetWorkerConnection() {
  connecting = null
}

async function establish(): Promise<MatrixWorkerClient | null> {
  if (typeof SharedWorker === 'undefined') {
    console.warn('[worker] SharedWorker unavailable — using an in-tab Matrix client')
    return null
  }

  let port: MessagePort
  try {
    const worker = new SharedWorker(new URL('./matrixWorker.ts', import.meta.url), {
      type: 'module',
      name: 'tidework-matrix',
    })
    port = worker.port
  } catch (err) {
    console.warn('[worker] SharedWorker failed to start — using an in-tab Matrix client', err)
    return null
  }

  const pending = new Map<number, { resolve: (r: Response) => void }>()
  const handlers = new Set<EventHandler>()
  let nextId = 1

  port.onmessage = (messageEvent: MessageEvent<Message>) => {
    const msg = messageEvent.data
    if (msg.kind === 'response') {
      pending.get(msg.id)?.resolve(msg)
      pending.delete(msg.id)
      return
    }
    if (msg.event === 'log') {
      // The worker's console is not this tab's, and nothing else can reach it.
      const line = `[worker] ${msg.message}`
      if (msg.level === 'error') console.error(line)
      else if (msg.level === 'warn') console.warn(line)
      else console.log(line)
      return
    }
    for (const handler of handlers) {
      try {
        handler(msg)
      } catch (err) {
        console.warn('[worker] event handler threw:', err)
      }
    }
  }
  port.start()

  // Best-effort: tell the worker this tab is gone so it can prune the port.
  // `pagehide` (not `unload`) is the event that still fires with the back/forward
  // cache in play.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      try {
        port.postMessage({ kind: 'bye' } satisfies Request)
      } catch {
        /* already gone */
      }
    })
  }

  const send = (req: UnsentRequest, timeoutMs?: number): Promise<Cloneable> => {
    const id = nextId++
    const full = { ...req, id } as Request
    return new Promise<Cloneable>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      pending.set(id, {
        resolve: (response) => {
          if (timer !== undefined) clearTimeout(timer)
          if (response.ok) resolve(response.value)
          else reject(new Error(response.error))
        },
      })
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Matrix worker did not answer ${full.kind} within ${timeoutMs}ms`))
        }, timeoutMs)
      }
      try {
        port.postMessage(full)
      } catch (err) {
        pending.delete(id)
        if (timer !== undefined) clearTimeout(timer)
        reject(err)
      }
    })
  }

  let info: PingInfo
  try {
    info = JSON.parse(
      (await send({ kind: 'ping', build: __BUILD_ID__ }, PING_TIMEOUT_MS)) as string,
    ) as PingInfo
  } catch (err) {
    console.warn('[worker] no answer from the shared worker — using an in-tab client', err)
    return null
  }
  if (!info.match) {
    // A deploy replaced this tab's assets while the worker (started by the older
    // bundle) stayed alive. Tab and worker hold SEPARATE wasm instances and only
    // exchange this small protocol, so skew is survivable — but it is exactly
    // the situation UpdateBanner exists to end, so say so out loud.
    console.warn(
      `[worker] build skew: tab ${__BUILD_ID__} vs worker ${info.build} — reload to realign`,
    )
  }
  console.log(
    `[worker] connected (build ${info.build}, ${info.sessions.length} live session(s))`,
  )

  return {
    info,
    async createSession(via, args, expectUserId) {
      const value = await send({ kind: 'session.create', via, args, expectUserId })
      return JSON.parse(value as string) as SessionInfo
    },
    async destroySession(userId) {
      await send({ kind: 'session.destroy', userId })
    },
    async openWorkspace(userId, roomId, snapshotJson) {
      await send({ kind: 'workspace.open', userId, roomId, snapshotJson })
    },
    async subscribe(roomId, tableIds) {
      await send({ kind: 'workspace.subscribe', roomId, tableIds })
    },
    sessionCall(userId, method, ...args) {
      return send({ kind: 'call', target: sessionKey(userId), method, args })
    },
    roomCall(roomId, method, ...args) {
      return send({ kind: 'call', target: roomKey(roomId), method, args })
    },
    staticCall(method, ...args) {
      return send({ kind: 'session.static', method, args })
    },
    async acquireVerification(userId, flowId) {
      return (await send({ kind: 'verification.acquire', userId, flowId })) as string | undefined
    },
    verificationCall(handle, method, ...args) {
      return send({ kind: 'call', target: handle, method, args })
    },
    on(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
}
