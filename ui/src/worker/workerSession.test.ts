import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openWorkerSession, wrapSession, type WorkerSession } from './workerSession'
import type { MatrixWorkerClient } from './client'
import type { Event, SessionInfo } from './protocol'

/**
 * The worker-backed `MatrixSession` stand-in (issue 87bf86a6).
 *
 * The two properties worth pinning are the ones `useAuth` depends on and that a
 * naive proxy would get wrong: `userId()`/`sessionData()` must stay
 * SYNCHRONOUS (`persistSessionBlob` reads the blob synchronously on every MAS
 * token refresh), and the cached blob must be updated BEFORE listeners run, or
 * the tab persists the token it just replaced.
 */

const USER = '@alice:example.org'

describe('worker-backed Matrix session', () => {
  let calls: Array<{ method: string; args: unknown[] }>
  let created: Array<{ via: string; expectUserId?: string }>
  let acquired: string[]
  let emit: (event: Event) => void
  let client: MatrixWorkerClient
  let info: SessionInfo

  beforeEach(() => {
    calls = []
    created = []
    acquired = []
    info = { userId: USER, sessionData: '{"token":"first"}', joined: false }
    const handlers = new Set<(e: Event) => void>()
    emit = event => handlers.forEach(h => h(event))
    client = {
      createSession: (via: string, _args: unknown[], expectUserId?: string) => {
        created.push({ via, expectUserId })
        return Promise.resolve(info)
      },
      sessionCall: (_userId: string, method: string, ...args: unknown[]) => {
        calls.push({ method, args })
        return Promise.resolve(method === 'recoveryUsesPassphrase' ? true : 'ok')
      },
      verificationCall: (_handle: string, method: string, ...args: unknown[]) => {
        calls.push({ method, args })
        return Promise.resolve(method === 'emoji' ? '[]' : 'pending')
      },
      acquireVerification: (_userId: string, flowId: string) => {
        acquired.push(flowId)
        return Promise.resolve(flowId === 'live' ? `verify:${flowId}` : undefined)
      },
      on: (handler: (e: Event) => void) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    } as unknown as MatrixWorkerClient
  })

  const session = (): WorkerSession => wrapSession(client, info)

  it('passes the expected MXID through so a restore can short-circuit', async () => {
    await openWorkerSession(client, 'restore', ['https://example.org', '{}'], USER)
    expect(created).toEqual([{ via: 'restore', expectUserId: USER }])
  })

  it('reports when it attached to a client another tab had already built', async () => {
    info = { ...info, joined: true }
    const ws = await openWorkerSession(client, 'restore', ['https://example.org', '{}'], USER)
    expect(ws.joined()).toBe(true)
  })

  it('answers userId and sessionData synchronously', () => {
    const ws = session()
    // No awaits: persistSessionBlob reads the blob synchronously.
    expect(ws.userId()).toBe(USER)
    expect(ws.sessionData()).toBe('{"token":"first"}')
  })

  it('updates the cached blob BEFORE notifying, on every token refresh', () => {
    const ws = session()
    const seen: string[] = []
    ws.startTokenPersistence(() => seen.push(ws.sessionData()))

    emit({ kind: 'event', event: 'token-refresh', userId: USER, sessionData: '{"token":"second"}' })

    // If the cache were updated after the callbacks, the tab would persist the
    // token it just replaced — a reload would then restore a dead MAS token.
    expect(seen).toEqual(['{"token":"second"}'])
    expect(ws.sessionData()).toBe('{"token":"second"}')
  })

  it('ignores events for a different account', () => {
    const ws = session()
    const onTokens = vi.fn()
    const onSync = vi.fn()
    ws.startTokenPersistence(onTokens)
    ws.startSessionSync(onSync)

    emit({ kind: 'event', event: 'token-refresh', userId: '@bob:example.org', sessionData: 'x' })
    emit({ kind: 'event', event: 'session-sync', userId: '@bob:example.org' })

    expect(onTokens).not.toHaveBeenCalled()
    expect(onSync).not.toHaveBeenCalled()
    expect(ws.sessionData()).toBe('{"token":"first"}')
  })

  it('starts the worker sync loop and fires on room-list changes', () => {
    const ws = session()
    const onSync = vi.fn()
    ws.startSessionSync(onSync)
    expect(calls.map(c => c.method)).toContain('startSessionSync')

    emit({ kind: 'event', event: 'session-sync', userId: USER })
    expect(onSync).toHaveBeenCalledTimes(1)
  })

  it('forwards the async surface useAuth drives', async () => {
    const ws = session()
    await ws.initialSync()
    await ws.listRooms()
    await ws.createRoom('Team')
    await ws.recoverWithKey('key')
    await ws.enableRecoveryWithPassphrase('secret')
    expect(await ws.recoveryUsesPassphrase()).toBe(true)
    expect(calls.map(c => c.method)).toEqual([
      'initialSync',
      'listRooms',
      'createRoom',
      'recoverWithKey',
      'enableRecoveryWithPassphrase',
      'recoveryUsesPassphrase',
    ])
    expect(calls[2].args).toEqual(['Team'])
  })

  it('wraps a live verification flow, and returns undefined for a stale one', async () => {
    const ws = session()
    expect(await ws.verificationForFlow('gone')).toBeUndefined()

    const handle = await ws.verificationForFlow('live')
    expect(acquired).toEqual(['gone', 'live'])
    expect(await handle!.state()).toBe('pending')
    expect(await handle!.emoji()).toBe('[]')
    await handle!.accept()
    expect(calls.map(c => c.method)).toEqual(['state', 'emoji', 'accept'])
  })

  it('stops listening on close without signing the account out', () => {
    const ws = session()
    const onTokens = vi.fn()
    ws.startTokenPersistence(onTokens)
    ws.close()
    emit({ kind: 'event', event: 'token-refresh', userId: USER, sessionData: 'x' })
    expect(onTokens).not.toHaveBeenCalled()
    // No destroy went to the worker: sibling tabs may still be using it.
    expect(calls.map(c => c.method)).not.toContain('session.destroy')
  })
})
