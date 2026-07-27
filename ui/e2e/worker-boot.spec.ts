import { test, expect, type Page } from '@playwright/test'
import { homeserverUrl, uniqueUser, PASSWORD } from './helpers'

/**
 * The Matrix SharedWorker, driven directly over its protocol (issue 87bf86a6).
 *
 * This is the architecture's feasibility test, and it is deliberately NOT a UI
 * test: it talks to `src/worker/matrixWorker.ts` through raw protocol messages,
 * so it pins the worker contract before any of the app is ported onto it (the
 * read-model and write-path stages follow). Nothing here goes through React, so
 * a failure points at the worker rather than at a grid selector.
 *
 * What it proves, in order:
 *
 *  1. wasm-bindgen's `--target web` glue loads inside a SharedWorker at all, and
 *     matrix-rust-sdk can open its IndexedDB crypto store there. Workers have no
 *     `window`/`document`/`localStorage`, so this was the real unknown.
 *  2. A SECOND page joins the running session and the running workspace instead
 *     of building rivals over the same store — the actual bug. Two clients over
 *     one crypto store is silent: the second one builds fine and only its writes
 *     never land, so the assertion is on `joined` and on the write arriving.
 *  3. A write issued by the second page reaches the server. Read back through a
 *     worker that gathers history from scratch, so a local optimistic copy can't
 *     make it look like it worked.
 *
 * Point 3 is what `multi-tab.spec.ts`'s two `test.fixme`s are waiting for; they
 * stay quarantined until the app itself is on this path.
 */

/** Bridge installed into a page: one SharedWorker port, promise per request. */
async function installProbe(page: Page) {
  await page.goto('/')
  await page.evaluate(async () => {
    const worker = new SharedWorker('/src/worker/matrixWorker.ts', {
      type: 'module',
      name: 'tidework-matrix',
    })
    const port = worker.port
    const pending = new Map<number, (r: any) => void>()
    const events: any[] = []
    let nextId = 1
    // A SharedWorker that fails to parse or load reports here and nowhere else;
    // without this the only symptom is a request that never answers.
    worker.onerror = (event: any) =>
      console.log(`[worker] FAILED TO LOAD: ${event?.message ?? 'unknown error'}`)
    port.onmessage = (event: MessageEvent) => {
      const msg = event.data
      if (msg.kind === 'response') {
        pending.get(msg.id)?.(msg)
        pending.delete(msg.id)
      } else {
        events.push(msg)
        // Worker-side logs are otherwise unreachable from a test.
        if (msg.event === 'log') console.log(`[worker] ${msg.message}`)
      }
    }
    port.start()
    // Vite must actually serve the worker module; if it 404s or hands back HTML
    // the failure is otherwise indistinguishable from a silent worker.
    try {
      const probe = await fetch('/src/worker/matrixWorker.ts')
      console.log(
        `[worker] module fetch ${probe.status} ${probe.headers.get('content-type')} ` +
          `${(await probe.text()).slice(0, 120).replace(/\n/g, ' ')}`,
      )
    } catch (err) {
      console.log(`[worker] module fetch failed: ${err}`)
    }
    ;(window as any).__probe = {
      events,
      send(req: Record<string, unknown>, timeoutMs = 240_000) {
        const id = nextId++
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`worker did not answer ${req.kind} in ${timeoutMs}ms`)),
            timeoutMs,
          )
          pending.set(id, (response: any) => {
            clearTimeout(timer)
            if (response.ok) resolve(response.value)
            else reject(new Error(response.error))
          })
          port.postMessage({ ...req, id })
        })
      },
    }
  })
}

/** Send one protocol request from `page` and return its value. */
function send<T = unknown>(page: Page, req: Record<string, unknown>, timeoutMs?: number): Promise<T> {
  return page.evaluate(
    ([r, t]) => (window as any).__probe.send(r, t),
    [req, timeoutMs] as [Record<string, unknown>, number | undefined],
  ) as Promise<T>
}

/** Events the worker has broadcast to this page so far. */
function events(page: Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__probe.events)
}

test('the shared worker owns one client per account and one workspace per room', async ({
  browser,
}) => {
  test.setTimeout(600_000)

  const context = await browser.newContext()
  const first = await context.newPage()
  first.on('console', m => console.log(`[page] ${m.text()}`))
  first.on('pageerror', e => console.log(`[page error] ${e.message}`))
  await installProbe(first)

  await test.step('the worker answers a ping and holds nothing yet', async () => {
    // Short bound: if the worker can't even load, that should fail in seconds.
    const info = JSON.parse(await send<string>(first, { kind: 'ping', build: 'e2e' }, 45_000))
    expect(info.sessions).toEqual([])
    expect(typeof info.build).toBe('string')
  })

  const username = uniqueUser('wboot')
  let userId = ''

  await test.step('wasm registers a real account from inside the worker', async () => {
    // The load-bearing step: this builds a matrix-rust-sdk client, an Olm
    // account and an IndexedDB crypto store in a SharedWorker context.
    const info = JSON.parse(
      await send<string>(first, {
        kind: 'session.create',
        via: 'register',
        args: [homeserverUrl(), username, PASSWORD],
      }),
    )
    userId = info.userId
    expect(userId).toContain(username)
    expect(info.joined).toBe(false)
    expect(JSON.parse(info.sessionData).storeName).toBeTruthy()
  })

  await send(first, { kind: 'call', target: `session:${userId}`, method: 'initialSync', args: [] })

  const roomId = await test.step('create a workspace room and open it', async () => {
    const id = await send<string>(first, {
      kind: 'call',
      target: `session:${userId}`,
      method: 'createRoom',
      args: ['Worker Boot'],
    })
    await send(first, { kind: 'call', target: `session:${userId}`, method: 'initialSync', args: [] })
    await send(first, { kind: 'workspace.open', userId, roomId: id })
    return id
  })

  const tableId = 'items'

  await test.step('the first page writes through the worker', async () => {
    await send(first, {
      kind: 'call',
      target: `room:${roomId}`,
      method: 'createTable',
      args: [
        JSON.stringify({
          id: tableId,
          name: 'Items',
          columns: { name: { id: 'name', name: 'Name', column_type: 'text', required: false, order: 0 } },
        }),
      ],
    })
    const tables = JSON.parse(
      await send<string>(first, { kind: 'call', target: `room:${roomId}`, method: 'listTables', args: [] }),
    )
    expect(JSON.stringify(tables)).toContain(tableId)
  })

  // ── The second page: the case that is broken without the worker ────────────

  const second = await context.newPage()
  second.on('console', m => console.log(`[page2] ${m.text()}`))
  second.on('pageerror', e => console.log(`[page2 error] ${e.message}`))
  await installProbe(second)

  await test.step('a second page joins the session instead of building a second client', async () => {
    const info = JSON.parse(
      await send<string>(second, {
        kind: 'session.create',
        via: 'restore',
        expectUserId: userId,
        // Deliberately unusable arguments: if the worker built a client from
        // them this call would fail, so a pass proves it short-circuited on
        // `expectUserId` and handed back the client the first page made.
        args: [homeserverUrl(), '{"not":"a session"}'],
      }),
    )
    expect(info.joined).toBe(true)
    expect(info.userId).toBe(userId)
  })

  await test.step('and joins the open workspace rather than re-gathering it', async () => {
    await send(second, { kind: 'workspace.open', userId, roomId })
    const rowsJson = await send<string>(second, {
      kind: 'call',
      target: `room:${roomId}`,
      method: 'getTableRows',
      args: [tableId],
    })
    expect(JSON.parse(rowsJson)).toEqual([])
  })

  await test.step("the second page's write reaches the server", async () => {
    await send(second, {
      kind: 'call',
      target: `room:${roomId}`,
      method: 'updateCell',
      args: [tableId, 'row-from-page-two', 'name', JSON.stringify('Written by page two')],
    })

    // Both pages see it, because there is one workspace and they share it…
    for (const page of [first, second]) {
      const rows = JSON.parse(
        await send<string>(page, {
          kind: 'call',
          target: `room:${roomId}`,
          method: 'getTableRows',
          args: [tableId],
        }),
      )
      expect(rows.map((r: any) => r.name)).toContain('Written by page two')
    }

    // …but materialized state proves nothing about the server: that is exactly
    // how the bug hides. The send queue only empties once the homeserver has
    // accepted the event, so a drained queue with no rejections IS server
    // receipt — and it is precisely what never happened for a second tab.
    await expect
      .poll(
        () =>
          send<string>(second, {
            kind: 'call',
            target: `room:${roomId}`,
            method: 'pendingUpdates',
            args: [],
          }),
        { timeout: 120_000, intervals: [1_000] },
      )
      .toBe('[]')

    const rejected = JSON.parse(
      await send<string>(second, {
        kind: 'call',
        target: `room:${roomId}`,
        method: 'rejectedWrites',
        args: [],
      }),
    )
    expect(rejected).toMatchObject({ count: 0 })
  })

  await test.step('a subscribed page is PUSHED materialized state it can read synchronously', async () => {
    // Option (b): the worker owns truth and pushes a bundle, so a tab answers
    // reads out of it without a client of its own. Run against the real bridge
    // because this is where a wrong method name or return shape would show up —
    // the unit tests use a fake workspace and cannot catch that.
    await send(first, { kind: 'workspace.subscribe', roomId, tableIds: [tableId] })

    let state: any = null
    await expect
      .poll(
        async () => {
          const pushed = (await events(first)).filter(e => e.event === 'workspace-state')
          if (pushed.length > 0) state = JSON.parse(pushed[pushed.length - 1].state)
          return pushed.length
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBeGreaterThan(0)

    expect(JSON.parse(state.tables)).toContain(tableId)
    expect(state.schemas[tableId]).toBeTruthy()
    expect(state.currentUserId).toBe(userId)
    expect(state.isEncrypted).toBe(true)
    // Rows are pushed only for the subscribed table, and carry the write that
    // the OTHER page made.
    expect(Object.keys(state.rows)).toEqual([tableId])
    expect(JSON.parse(state.rows[tableId]).map((r: any) => r.name)).toContain('Written by page two')
  })

  await test.step('the worker broadcast its change events to both pages', async () => {
    // Replaces the per-tab BroadcastChannel ping: the sync echo of the write
    // lands on the ONE client and fans out to every port. Polled because the
    // echo can trail the queue drain by a sync round-trip.
    for (const page of [first, second]) {
      await expect
        .poll(async () => (await events(page)).some(e => e.event === 'workspace-change' && e.roomId === roomId), {
          timeout: 60_000,
          intervals: [1_000],
        })
        .toBe(true)
    }
  })

  await context.close()
})
