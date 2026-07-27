import { test, expect } from '@playwright/test'
import { homeserverUrl, uniqueUser, PASSWORD } from './helpers'

/**
 * The passkey wrap, end to end against a real homeserver (issue 63dc1339).
 *
 * Stage 1 of recovery-key-first custody: the passkey stores an encrypted copy
 * OF the recovery key in account data, rather than becoming a second
 * secret-storage key. This spec pins the mechanism before any UI is built on it
 * — the unit tests cover the crypto against fakes, and what they cannot cover is
 * whether the account-data transport actually survives a homeserver round trip
 * through the SharedWorker.
 *
 * Driven over the worker protocol rather than through React, so a failure points
 * at the mechanism rather than at a screen that does not exist yet.
 */

/** Bridge a page to the SharedWorker, as `worker-boot.spec.ts` does. */
async function installProbe(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.evaluate(async () => {
    const worker = new SharedWorker('/src/worker/matrixWorker.ts', {
      type: 'module',
      name: 'tidework-matrix',
    })
    const port = worker.port
    const pending = new Map<number, (r: any) => void>()
    let nextId = 1
    worker.onerror = (event: any) =>
      console.log(`[worker] FAILED TO LOAD: ${event?.message ?? 'unknown error'}`)
    port.onmessage = (event: MessageEvent) => {
      const msg = event.data
      if (msg.kind === 'response') {
        pending.get(msg.id)?.(msg)
        pending.delete(msg.id)
      } else if (msg.event === 'log') {
        console.log(`[worker] ${msg.message}`)
      }
    }
    port.start()
    ;(window as any).__probe = {
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

function send<T = unknown>(
  page: import('@playwright/test').Page,
  req: Record<string, unknown>,
): Promise<T> {
  return page.evaluate(r => (window as any).__probe.send(r), req) as Promise<T>
}

test('a passkey wrap survives a homeserver round trip and a fresh device', async ({ browser }) => {
  test.setTimeout(600_000)

  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('console', m => {
    if (m.text().startsWith('[worker]')) console.log(m.text())
  })
  await installProbe(page)

  const username = uniqueUser('pkwrap')
  const info = JSON.parse(
    await send<string>(page, {
      kind: 'session.create',
      via: 'register',
      args: [homeserverUrl(), username, PASSWORD],
    }),
  )
  const userId: string = info.userId
  await send(page, { kind: 'call', target: `session:${userId}`, method: 'initialSync', args: [] })

  const EVENT_TYPE = 'io.tidework.passkey_wrap'

  await test.step('an account with no passkey has no wrap record', async () => {
    const raw = await send(page, {
      kind: 'call',
      target: `session:${userId}`,
      method: 'getAccountData',
      args: [EVENT_TYPE],
    })
    expect(raw).toBeUndefined()
  })

  // A wrap the UI would have produced: AES-GCM over the recovery key, keyed by
  // the passkey's PRF output. Its exact bytes don't matter here — what matters
  // is that the homeserver stores and returns them intact.
  const record = JSON.stringify({
    v: 1,
    wraps: [{ credentialId: 'cred-laptop', wrap: 'Zm9vYmFyLWNpcGhlcnRleHQ', addedAt: 1 }],
  })

  await test.step('the wrap round-trips through account data', async () => {
    await send(page, {
      kind: 'call',
      target: `session:${userId}`,
      method: 'setAccountData',
      args: [EVENT_TYPE, record],
    })
    const raw = await send<string>(page, {
      kind: 'call',
      target: `session:${userId}`,
      method: 'getAccountData',
      args: [EVENT_TYPE],
    })
    expect(JSON.parse(raw)).toEqual(JSON.parse(record))
  })

  await test.step('a second passkey can be added without displacing the first', async () => {
    // The property the whole design exists for: enrolling another passkey is an
    // ordinary account-data update, not a secret-storage rotation.
    const both = JSON.parse(record)
    both.wraps.push({ credentialId: 'cred-phone', wrap: 'YW5vdGhlci1jaXBoZXJ0ZXh0', addedAt: 2 })
    await send(page, {
      kind: 'call',
      target: `session:${userId}`,
      method: 'setAccountData',
      args: [EVENT_TYPE, JSON.stringify(both)],
    })
    const raw = await send<string>(page, {
      kind: 'call',
      target: `session:${userId}`,
      method: 'getAccountData',
      args: [EVENT_TYPE],
    })
    expect(JSON.parse(raw).wraps.map((w: any) => w.credentialId)).toEqual([
      'cred-laptop',
      'cred-phone',
    ])
  })

  await test.step('a FRESH device reads the same wraps', async () => {
    // The reason the wrap lives in account data rather than only on the device:
    // a new device must be able to unlock with the passkey alone.
    const other = await browser.newContext()
    const fresh = await other.newPage()
    await installProbe(fresh)
    const freshInfo = JSON.parse(
      await send<string>(fresh, {
        kind: 'session.create',
        via: 'login',
        args: [homeserverUrl(), username, PASSWORD],
      }),
    )
    expect(freshInfo.userId).toBe(userId)
    await send(fresh, {
      kind: 'call',
      target: `session:${userId}`,
      method: 'initialSync',
      args: [],
    })
    const raw = await send<string>(fresh, {
      kind: 'call',
      target: `session:${userId}`,
      method: 'getAccountData',
      args: [EVENT_TYPE],
    })
    expect(JSON.parse(raw).wraps).toHaveLength(2)
    await other.close()
  })

  await context.close()
})
