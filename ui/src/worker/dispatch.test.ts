import { describe, it, expect, beforeEach } from 'vitest'
import { createDispatcher, type Dispatcher } from './dispatch'
import type { Event, PingInfo, Response, SessionInfo } from './protocol'

/**
 * Unit tests for the SharedWorker's dispatcher (issue 87bf86a6). A real
 * SharedWorker is unreachable from jsdom, so the dispatcher takes its wasm
 * module as a dependency and is exercised against a fake one here.
 *
 * The tests that matter most are the DEDUPE ones: "one client per account" and
 * "one workspace per room" are the entire fix, and the failure mode they guard
 * against (two clients over one crypto store) is silent — a second client builds
 * fine and only its writes never land. So the assertion is on the construction
 * count, not on any observable error.
 */

const ROOM = '!room:example.org'
const USER = '@alice:example.org'

interface FakeWasm {
  MatrixSession: any
  ConnectedWorkspace: any
  /** How many clients were built, per factory. */
  built: { login: number; register: number; restore: number; finishOauthLogin: number }
  workspacesCreated: number
  syncsStarted: number
  /** How many times the session-level sync loop was installed. */
  sessionSyncInstalls: number
  /** Fires the on_change callback the worker installed for a room. */
  fireSync: (roomId: string) => void
  fireQueueChange: (roomId: string) => void
  fireTokenRefresh: (blob: string) => void
}

function makeWasm(options: { userId?: string; restoreDelayMs?: number } = {}): FakeWasm {
  const userId = options.userId ?? USER
  const built = { login: 0, register: 0, restore: 0, finishOauthLogin: 0 }
  const syncCallbacks = new Map<string, () => void>()
  const queueCallbacks = new Map<string, () => void>()
  let tokenCallback: ((blob: string) => void) | undefined
  const state = {
    workspacesCreated: 0,
    syncsStarted: 0,
    sessionSyncInstalls: 0,
    rowsByTable: {} as Record<string, Array<Record<string, unknown>>>,
  }

  const makeSession = () => ({
    userId: () => userId,
    sessionData: () => JSON.stringify({ storeName: 'store-1' }),
    startTokenPersistence: (cb: (blob: string) => void) => {
      tokenCallback = cb
    },
    startSessionSync: () => {
      state.sessionSyncInstalls++
    },
    listRooms: async () => '[]',
    recoveryStatus: () => 'ready',
    // Not on the allowlist — proves an unlisted method is refused.
    getDisplayNameObject: async () => ({ name: 'Alice' }),
    verificationForFlow: async (flowId: string) =>
      flowId === 'live' ? { flowId: () => 'live', state: () => 'pending' } : undefined,
  })

  const MatrixSession = {
    login: async () => {
      built.login++
      return makeSession()
    },
    register: async () => {
      built.register++
      return makeSession()
    },
    restore: async () => {
      built.restore++
      if (options.restoreDelayMs) {
        await new Promise(resolve => setTimeout(resolve, options.restoreDelayMs))
      }
      return makeSession()
    },
    finishOauthLogin: async () => {
      built.finishOauthLogin++
      return makeSession()
    },
    homeserverSupportsOauth: async () => true,
    startOauthLogin: async () => 'https://auth.example.org/authorize',
  }

  const ConnectedWorkspace = {
    create: async (_session: unknown, roomId: string) => {
      state.workspacesCreated++
      return {
        startSync: (cb: () => void) => {
          state.syncsStarted++
          syncCallbacks.set(roomId, cb)
        },
        onQueueChanged: (cb: () => void) => queueCallbacks.set(roomId, cb),
        getTableRows: (tableId: string) => JSON.stringify(state.rowsByTable[tableId] ?? []),
        getRowOrderKeys: () => '{"r1":"a0"}',
        getTableSchema: (tableId: string) => JSON.stringify({ id: tableId, name: 'Items' }),
        // Both of these return arrays of ID STRINGS in the real bridge. The
        // fake said `{id}` objects at first, the dispatcher believed it, and the
        // e2e against the real bridge is what caught the empty schema map.
        listTables: () => JSON.stringify(['items', 'other']),
        listViewsForTable: (tableId: string) =>
          JSON.stringify(tableId === 'items' ? ['view-1'] : []),
        getView: (viewId: string) => JSON.stringify({ id: viewId, table_id: 'items' }),
        getTableOrderKeys: () => '{"items":"a0"}',
        isEncrypted: () => true,
        undecryptableCount: () => 0,
        connectionHealth: () => '{"state":"ok"}',
        rejectedWrites: () => '{"count":0,"lastReason":""}',
        pendingUpdates: () => '[]',
        updateCell: async (tableId: string, rowId: string, columnId: string, valueJson: string) => {
          const rows = (state.rowsByTable[tableId] ??= [])
          rows.push({ _row_id: rowId, [columnId]: JSON.parse(valueJson) })
        },
        currentUserId: () => userId,
        snapshot: () => '{"version":1}',
        exportWorkspaceZip: () => new Uint8Array([1, 2, 3]),
        // Allowlisted, but returns an object — the cloneability guard's target.
        listMembers: async () => [{ userId }],
      }
    },
  }

  return {
    MatrixSession,
    ConnectedWorkspace,
    built,
    get workspacesCreated() {
      return state.workspacesCreated
    },
    get syncsStarted() {
      return state.syncsStarted
    },
    get sessionSyncInstalls() {
      return state.sessionSyncInstalls
    },
    fireSync: (roomId: string) => syncCallbacks.get(roomId)?.(),
    fireQueueChange: (roomId: string) => queueCallbacks.get(roomId)?.(),
    fireTokenRefresh: (blob: string) => tokenCallback?.(blob),
  }
}

/** Unwrap a successful response, failing the test on an error response. */
function value(response: Response | null): string {
  if (!response || response.kind !== 'response') throw new Error('no response')
  if (!response.ok) throw new Error(`unexpected error response: ${response.error}`)
  return response.value as string
}

/** Assert an error response and return its message. */
function errorOf(response: Response | null): string {
  if (!response || !('ok' in response) || response.ok) throw new Error('expected an error response')
  return response.error
}

describe('worker dispatcher', () => {
  let wasm: FakeWasm
  let events: Event[]
  let dispatcher: Dispatcher

  const setup = (w: FakeWasm = makeWasm()) => {
    wasm = w
    events = []
    dispatcher = createDispatcher({
      loadWasm: async () => wasm,
      broadcast: e => events.push(e),
    })
    return dispatcher
  }

  const restore = (id: number, expectUserId?: string) =>
    dispatcher.handle({
      kind: 'session.create',
      id,
      via: 'restore',
      expectUserId,
      args: ['https://example.org', '{}'],
    })

  const openRoom = (id: number, roomId = ROOM) =>
    dispatcher.handle({ kind: 'workspace.open', id, userId: USER, roomId })

  beforeEach(() => {
    setup()
  })

  // ── The fix: one client per account ────────────────────────────────────────

  it('builds one client for the first restore', async () => {
    const info = JSON.parse(value(await restore(1, USER))) as SessionInfo
    expect(wasm.built.restore).toBe(1)
    expect(info.userId).toBe(USER)
    expect(info.joined).toBe(false)
  })

  it('a second tab joins the existing session instead of building a rival', async () => {
    await restore(1, USER)
    const second = JSON.parse(value(await restore(2, USER))) as SessionInfo

    // The whole point: no second client over the same crypto store.
    expect(wasm.built.restore).toBe(1)
    expect(second.joined).toBe(true)
    expect(second.userId).toBe(USER)
  })

  it('two tabs restoring at the same instant share one in-flight build', async () => {
    // Without in-flight sharing both callers miss the "already exists" check and
    // each builds a client — the original bug, just with a narrower window.
    setup(makeWasm({ restoreDelayMs: 20 }))
    const [a, b] = await Promise.all([restore(1, USER), restore(2, USER)])

    expect(wasm.built.restore).toBe(1)
    const infos = [a, b].map(r => JSON.parse(value(r)) as SessionInfo)
    expect(infos.filter(i => i.joined)).toHaveLength(1)
    expect(infos.every(i => i.userId === USER)).toBe(true)
  })

  it('a fresh login for a held account replaces it and tells sibling tabs', async () => {
    await restore(1, USER)
    await dispatcher.handle({
      kind: 'session.create',
      id: 2,
      via: 'login',
      args: ['https://example.org', 'alice', 'pw'],
    })
    expect(events).toContainEqual({ kind: 'event', event: 'session-dropped', userId: USER })
  })

  it('validates factory arity instead of splatting args into wasm', async () => {
    const message = errorOf(
      await dispatcher.handle({
        kind: 'session.create',
        id: 1,
        via: 'restore',
        args: ['https://example.org'],
      }),
    )
    expect(message).toMatch(/takes 2–3 args/)
    expect(wasm.built.restore).toBe(0)
  })

  // ── The fix: one workspace (and one sync loop) per room ────────────────────

  it('a second tab joins the open workspace, starting no second sync loop', async () => {
    await restore(1, USER)
    await openRoom(2)
    await openRoom(3)

    expect(wasm.workspacesCreated).toBe(1)
    expect(wasm.syncsStarted).toBe(1)
    expect(dispatcher.inspect().rooms).toEqual([ROOM])
  })

  it('two tabs opening a room at the same instant share one build', async () => {
    await restore(1, USER)
    await Promise.all([openRoom(2), openRoom(3)])
    expect(wasm.workspacesCreated).toBe(1)
  })

  it('refuses to open a workspace for an account it has no session for', async () => {
    expect(errorOf(await openRoom(1))).toMatch(/No session for/)
  })

  // ── Callbacks become events ───────────────────────────────────────────────

  it('broadcasts a data-free change event when the sync loop sees remote writes', async () => {
    await restore(1, USER)
    await openRoom(2)
    wasm.fireSync(ROOM)
    expect(events).toContainEqual({ kind: 'event', event: 'workspace-change', roomId: ROOM })
  })

  it('broadcasts queue changes so tabs can mirror the outbox', async () => {
    await restore(1, USER)
    await openRoom(2)
    wasm.fireQueueChange(ROOM)
    expect(events).toContainEqual({ kind: 'event', event: 'queue-change', roomId: ROOM })
  })

  it('forwards refreshed tokens to tabs, which own persistence', async () => {
    await restore(1, USER)
    wasm.fireTokenRefresh('{"token":"new"}')
    expect(events).toContainEqual({
      kind: 'event',
      event: 'token-refresh',
      userId: USER,
      sessionData: '{"token":"new"}',
    })
  })

  it('starts the session-level sync loop at most once', async () => {
    // Every tab on the Workspaces page calls this. Installing it per tab would
    // put N sync loops on one client — the same over-subscription the worker
    // exists to prevent, one level up.
    await restore(1, USER)
    for (const id of [2, 3, 4]) {
      await dispatcher.handle({ kind: 'call', id, target: `session:${USER}`, method: 'startSessionSync', args: [] })
    }
    expect(wasm.sessionSyncInstalls).toBe(1)
  })

  // ── Generic call path ─────────────────────────────────────────────────────

  it('calls allowlisted methods on a session handle', async () => {
    await restore(1, USER)
    const rooms = value(
      await dispatcher.handle({ kind: 'call', id: 2, target: `session:${USER}`, method: 'listRooms', args: [] }),
    )
    expect(rooms).toBe('[]')
  })

  it('calls allowlisted methods on a room handle, awaiting sync and async alike', async () => {
    await restore(1, USER)
    await openRoom(2)
    expect(
      value(await dispatcher.handle({ kind: 'call', id: 3, target: `room:${ROOM}`, method: 'getTableRows', args: ['t1'] })),
    ).toBe('[]')
    const write = await dispatcher.handle({
      kind: 'call',
      id: 4,
      target: `room:${ROOM}`,
      method: 'updateCell',
      args: ['t1', 'r1', 'c1', '"x"'],
    })
    expect(write && 'ok' in write && write.ok).toBe(true)
  })

  it('carries binary returns across as Uint8Array', async () => {
    await restore(1, USER)
    await openRoom(2)
    const response = await dispatcher.handle({
      kind: 'call',
      id: 3,
      target: `room:${ROOM}`,
      method: 'exportWorkspaceZip',
      args: ['ws'],
    })
    if (!response || !('ok' in response) || !response.ok) throw new Error('expected ok')
    expect(response.value).toBeInstanceOf(Uint8Array)
  })

  it('rejects methods outside the allowlist', async () => {
    await restore(1, USER)
    expect(
      errorOf(
        await dispatcher.handle({
          kind: 'call',
          id: 2,
          target: `session:${USER}`,
          method: 'getDisplayNameObject',
          args: [],
        }),
      ),
    ).toMatch(/not callable from a tab/)
  })

  it('rejects a call on an unknown handle rather than resolving undefined', async () => {
    expect(
      errorOf(await dispatcher.handle({ kind: 'call', id: 1, target: 'room:!nope:x', method: 'getTableRows', args: ['t'] })),
    ).toMatch(/is not open/)
  })

  it('turns a non-transferable return into a clear error, not a DataCloneError', async () => {
    // `listMembers` is allowlisted, so this proves the guard rather than the
    // allowlist. It matters because a DataCloneError raised inside postMessage
    // loses the request id, leaving the calling tab waiting forever.
    await restore(1, USER)
    await openRoom(2)
    expect(
      errorOf(
        await dispatcher.handle({
          kind: 'call',
          id: 3,
          target: `room:${ROOM}`,
          method: 'listMembers',
          args: [],
        }),
      ),
    ).toMatch(/non-transferable object/)
  })

  it('calls a plain sync method through the same path', async () => {
    await restore(1, USER)
    expect(
      value(await dispatcher.handle({ kind: 'call', id: 2, target: `session:${USER}`, method: 'recoveryStatus', args: [] })),
    ).toBe('ready')
  })

  // ── Verification handles ──────────────────────────────────────────────────

  it('registers a verification handle and calls through it', async () => {
    await restore(1, USER)
    const handle = value(
      await dispatcher.handle({ kind: 'verification.acquire', id: 2, userId: USER, flowId: 'live' }),
    )
    expect(handle).toBe('verify:live')
    expect(
      value(await dispatcher.handle({ kind: 'call', id: 3, target: handle, method: 'state', args: [] })),
    ).toBe('pending')
  })

  it('resolves undefined for a verification flow that has gone away', async () => {
    await restore(1, USER)
    const response = await dispatcher.handle({
      kind: 'verification.acquire',
      id: 2,
      userId: USER,
      flowId: 'stale',
    })
    if (!response || !('ok' in response) || !response.ok) throw new Error('expected ok')
    expect(response.value).toBeUndefined()
  })

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it('adopts the first tab’s build id and reports skew against it', async () => {
    // The worker cannot read `__BUILD_ID__` itself (Vite's define doesn't reach a
    // dev-served worker), so its identity is the bundle that started it.
    const first = JSON.parse(value(await dispatcher.handle({ kind: 'ping', id: 1, build: 'build-1' }))) as PingInfo
    expect(first).toMatchObject({ build: 'build-1', match: true })
    const stale = JSON.parse(value(await dispatcher.handle({ kind: 'ping', id: 2, build: 'build-0' }))) as PingInfo
    expect(stale).toMatchObject({ build: 'build-1', match: false })
  })

  it('lists held sessions through ping', async () => {
    await restore(1, USER)
    const info = JSON.parse(value(await dispatcher.handle({ kind: 'ping', id: 2, build: 'build-1' }))) as PingInfo
    expect(info.sessions).toEqual([USER])
  })

  it('destroying a session drops its handles and announces it', async () => {
    await restore(1, USER)
    await openRoom(2)
    await dispatcher.handle({ kind: 'session.destroy', id: 3, userId: USER })
    expect(dispatcher.inspect()).toMatchObject({ sessions: [], rooms: [] })
    expect(events).toContainEqual({ kind: 'event', event: 'session-dropped', userId: USER })
    expect(errorOf(await dispatcher.handle({ kind: 'call', id: 4, target: `session:${USER}`, method: 'listRooms', args: [] })))
      .toMatch(/No session for/)
  })

  // ── Pushed materialized state (option b) ──────────────────────────────────

  describe('materialized state', () => {
    /** A fake tab: collects what the worker pushes to it. */
    const makeClient = () => {
      const received: Event[] = []
      return { client: { send: (e: Event) => (received.push(e), true) }, received }
    }
    const states = (received: Event[]) =>
      received.filter(e => e.event === 'workspace-state').map(e => JSON.parse((e as any).state))
    /** Let the `setTimeout(0)` push land. */
    const settle = () => new Promise(resolve => setTimeout(resolve, 5))

    const subscribed = async (tableIds: string[]) => {
      await restore(1, USER)
      await openRoom(2)
      const tab = makeClient()
      await dispatcher.handle(
        { kind: 'workspace.subscribe', id: 3, roomId: ROOM, tableIds },
        tab.client,
      )
      await settle()
      return tab
    }

    it('pushes a bundle on subscribe, with rows only for the named tables', async () => {
      const tab = await subscribed(['items'])
      const [state] = states(tab.received)
      expect(state).toBeTruthy()
      // Metadata for every table…
      expect(Object.keys(state.schemas).sort()).toEqual(['items', 'other'])
      expect(state.views['view-1']).toContain('view-1')
      expect(state.tableOrderKeys).toBe('{"items":"a0"}')
      expect(state.isEncrypted).toBe(true)
      // …rows only for what this tab is showing, because rows are the only part
      // whose size scales with the data.
      expect(Object.keys(state.rows)).toEqual(['items'])
    })

    it('refuses to subscribe to a workspace that is not open', async () => {
      await restore(1, USER)
      const tab = makeClient()
      const response = await dispatcher.handle(
        { kind: 'workspace.subscribe', id: 2, roomId: ROOM, tableIds: [] },
        tab.client,
      )
      expect(errorOf(response)).toMatch(/is not open/)
    })

    it("pushes a sibling tab's write immediately, not on the homeserver echo", async () => {
      // This is what replaces "the other tab catches up when you switch to it".
      const reader = await subscribed(['items'])
      const writer = makeClient()
      await dispatcher.handle(
        { kind: 'workspace.subscribe', id: 4, roomId: ROOM, tableIds: ['items'] },
        writer.client,
      )
      await settle()
      const before = states(reader.received).length

      await dispatcher.handle(
        {
          kind: 'call',
          id: 5,
          target: `room:${ROOM}`,
          method: 'updateCell',
          args: ['items', 'r1', 'name', '"from the other tab"'],
        },
        writer.client,
      )
      await settle()

      const pushed = states(reader.received)
      expect(pushed.length).toBeGreaterThan(before)
      expect(JSON.parse(pushed[pushed.length - 1].rows.items)).toEqual([
        { _row_id: 'r1', name: 'from the other tab' },
      ])
    })

    it('does not re-push for a read', async () => {
      const tab = await subscribed(['items'])
      const before = states(tab.received).length
      await dispatcher.handle(
        { kind: 'call', id: 4, target: `room:${ROOM}`, method: 'getTableRows', args: ['items'] },
        tab.client,
      )
      await settle()
      expect(states(tab.received)).toHaveLength(before)
    })

    it('pushes to every subscribed tab when the sync loop sees remote writes', async () => {
      const a = await subscribed(['items'])
      const b = makeClient()
      await dispatcher.handle(
        { kind: 'workspace.subscribe', id: 4, roomId: ROOM, tableIds: ['other'] },
        b.client,
      )
      await settle()
      const [beforeA, beforeB] = [states(a.received).length, states(b.received).length]

      wasm.fireSync(ROOM)
      await settle()

      expect(states(a.received).length).toBeGreaterThan(beforeA)
      expect(states(b.received).length).toBeGreaterThan(beforeB)
      // Each tab gets rows for ITS tables, not the union.
      expect(Object.keys(states(a.received).pop().rows)).toEqual(['items'])
      expect(Object.keys(states(b.received).pop().rows)).toEqual(['other'])
    })

    it('re-subscribing replaces the table set rather than adding to it', async () => {
      await restore(1, USER)
      await openRoom(2)
      const tab = makeClient()
      for (const [id, tableIds] of [[3, ['items']], [4, ['other']]] as const) {
        await dispatcher.handle({ kind: 'workspace.subscribe', id, roomId: ROOM, tableIds: [...tableIds] }, tab.client)
      }
      await settle()
      expect(Object.keys(states(tab.received).pop().rows)).toEqual(['other'])
    })

    it('drops a tab that has gone away instead of pushing into the void', async () => {
      await restore(1, USER)
      await openRoom(2)
      let alive = true
      const client = { send: () => alive }
      await dispatcher.handle({ kind: 'workspace.subscribe', id: 3, roomId: ROOM, tableIds: [] }, client)
      await settle()
      expect(dispatcher.inspect().subscribers).toBe(1)

      alive = false // the tab closed; postMessage now fails
      wasm.fireSync(ROOM)
      await settle()
      expect(dispatcher.inspect().subscribers).toBe(0)
    })

    it('forgets subscriptions on an explicit disconnect', async () => {
      const tab = await subscribed([])
      expect(dispatcher.inspect().subscribers).toBe(1)
      dispatcher.disconnect(tab.client)
      expect(dispatcher.inspect().subscribers).toBe(0)
    })

    it('survives a read method that throws, pushing the rest of the bundle', async () => {
      // A bundle is worth pushing even when one field can't be read; the
      // alternative is a grid that stops updating because of a peripheral field.
      const broken = makeWasm()
      const originalCreate = broken.ConnectedWorkspace.create
      broken.ConnectedWorkspace.create = async (session: unknown, roomId: string) => {
        const ws = await originalCreate(session, roomId)
        ws.connectionHealth = () => {
          throw new Error('health unavailable')
        }
        return ws
      }
      setup(broken)
      const tab = await subscribed(['items'])
      const [state] = states(tab.received)
      expect(state.connectionHealth).toBe('{}') // the fallback
      expect(state.tables).toContain('items') // …and the rest still arrived
    })
  })

  it('answers nothing to a goodbye', async () => {
    expect(await dispatcher.handle({ kind: 'bye' })).toBeNull()
  })

  it('answers a failing call with an error response and logs it for the tab', async () => {
    setup({
      ...makeWasm(),
      MatrixSession: {
        restore: async () => {
          throw new Error('homeserver unreachable')
        },
      },
    } as FakeWasm)
    expect(errorOf(await restore(1, USER))).toBe('homeserver unreachable')
    expect(events.some(e => e.event === 'log' && /homeserver unreachable/.test(e.message))).toBe(true)
  })
})
