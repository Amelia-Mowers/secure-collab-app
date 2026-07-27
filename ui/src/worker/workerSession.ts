/**
 * A stand-in for `MatrixSession` backed by the SharedWorker (issue 87bf86a6).
 *
 * `useAuth` holds a `matrixSession` object and calls ~20 methods on it. This
 * presents the same surface while the real client lives in the worker, so a
 * second tab drives the FIRST tab's client instead of building a rival over the
 * same crypto store.
 *
 * WHAT STAYS IN THE TAB, because it cannot move:
 *  - WebAuthn / passkey PRF — `navigator.credentials` does not exist in a
 *    worker. The tab performs the gesture and sends only the derived secret.
 *  - The OAuth popup — needs a window. The tab drives it and sends the
 *    redirected URL.
 *  - `localStorage` — the tab remains the owner of the persisted account pool.
 *    The worker hands back session blobs; the tab encrypts and stores them.
 *
 * WHAT CHANGES SHAPE. Three methods are synchronous on the real bridge and
 * cannot be here, because the answer lives across a port:
 *
 *      recoveryStatus()          already awaited at its call site — no change
 *      pendingVerificationFlow() call site must add `await`
 *      DeviceVerification.emoji()/state()/isDone()  call sites must add `await`
 *
 * `userId()` and `sessionData()` stay synchronous — they are answered from the
 * session info the worker returned, kept current by `token-refresh` events. That
 * matters: `persistSessionBlob` reads `sessionData()` synchronously on every
 * token refresh, and MAS tokens refresh often.
 */

import type { MatrixWorkerClient } from './client'
import type { Cloneable, SessionInfo } from './protocol'

/** The subset of `DeviceVerification` the verify flow drives, over a port. */
export interface WorkerVerification {
  flowId(): Promise<string>
  accept(): Promise<void>
  /** JSON array of SAS emoji. Async here; sync on the real bridge. */
  emoji(): Promise<string>
  confirm(): Promise<void>
  cancel(): Promise<void>
  isDone(): Promise<boolean>
  advance(): Promise<string>
  state(): Promise<string>
}

export interface WorkerSession {
  /**
   * Brand. `useWorkspace` routes on THIS, not on the feature flag: a tab that
   * built a worker-backed session and then opened an in-tab workspace would
   * create exactly the second client over one crypto store that this all exists
   * to prevent. Deciding from the session object makes that mismatch
   * unrepresentable.
   */
  readonly isWorkerSession: true
  /** MXID. Synchronous: it came back with the session info. */
  userId(): string
  /** The opaque session blob the tab persists. Synchronous, and kept current by
   *  `token-refresh` pushes. */
  sessionData(): string
  /** True when this tab ATTACHED to a client another tab had already built —
   *  the observable signature of the fix. */
  joined(): boolean

  initialSync(): Promise<void>
  listRooms(): Promise<string>
  listInvitedRooms(): Promise<string>
  createRoom(name: string): Promise<string>
  joinRoom(roomId: string): Promise<void>
  declineInvite(roomId: string): Promise<void>
  getDisplayName(): Promise<string>
  setDisplayName(name: string): Promise<void>

  recoveryStatus(): Promise<string>
  recoveryUsesPassphrase(): Promise<boolean>
  enableRecovery(): Promise<string>
  enableRecoveryWithPassphrase(passphrase: string): Promise<string>
  resetRecovery(): Promise<string>
  resetRecoveryWithPassphrase(passphrase: string): Promise<string>
  recoverWithKey(key: string): Promise<void>
  requestOpenIdToken(): Promise<string>

  /** Fires whenever the SDK refreshes its tokens, so the tab can re-persist. */
  startTokenPersistence(onTokens: (blob: string) => void): void
  /** Starts the worker's session-level sync (once per account, however many
   *  tabs ask) and fires when the room list changes. */
  startSessionSync(onChange: () => void): void
  startVerificationListener(): Promise<void>
  /** Async here; synchronous on the real bridge. */
  pendingVerificationFlow(): Promise<string | undefined>
  verificationForFlow(flowId: string): Promise<WorkerVerification | undefined>

  /** Stop listening for worker events. Does NOT sign out — other tabs may still
   *  be using this session. */
  close(): void
}

/**
 * Create or JOIN the worker's session for an account, and wrap it.
 *
 * `expectUserId` (known whenever an account is being RESTORED) lets the worker
 * hand back an existing client without building anything, which is the second
 * tab's happy path. Login/register/OAuth cannot know it up front.
 */
export async function openWorkerSession(
  client: MatrixWorkerClient,
  via: 'login' | 'register' | 'restore' | 'finishOauthLogin',
  args: Cloneable[],
  expectUserId?: string,
): Promise<WorkerSession> {
  const info = await client.createSession(via, args, expectUserId)
  return wrapSession(client, info)
}

/** Wrap session info the worker already returned. Exported for tests. */
export function wrapSession(client: MatrixWorkerClient, info: SessionInfo): WorkerSession {
  const userId = info.userId
  let sessionData = info.sessionData
  const tokenListeners = new Set<(blob: string) => void>()
  const syncListeners = new Set<() => void>()

  const unsubscribe = client.on(event => {
    if (event.event === 'token-refresh' && event.userId === userId) {
      // Cache first, then notify: a listener that reads `sessionData()` (as
      // `persistSessionBlob` does) must see the new blob, not the old one.
      sessionData = event.sessionData
      for (const listener of tokenListeners) listener(event.sessionData)
      return
    }
    if (event.event === 'session-sync' && event.userId === userId) {
      for (const listener of syncListeners) listener()
    }
  })

  const call = (method: string, ...args: Cloneable[]) =>
    client.sessionCall(userId, method, ...args)

  return {
    isWorkerSession: true,
    userId: () => userId,
    sessionData: () => sessionData,
    joined: () => info.joined,

    initialSync: () => call('initialSync') as Promise<void>,
    listRooms: () => call('listRooms') as Promise<string>,
    listInvitedRooms: () => call('listInvitedRooms') as Promise<string>,
    createRoom: name => call('createRoom', name) as Promise<string>,
    joinRoom: roomId => call('joinRoom', roomId) as Promise<void>,
    declineInvite: roomId => call('declineInvite', roomId) as Promise<void>,
    getDisplayName: () => call('getDisplayName') as Promise<string>,
    setDisplayName: name => call('setDisplayName', name) as Promise<void>,

    recoveryStatus: () => call('recoveryStatus') as Promise<string>,
    recoveryUsesPassphrase: () => call('recoveryUsesPassphrase') as Promise<boolean>,
    enableRecovery: () => call('enableRecovery') as Promise<string>,
    enableRecoveryWithPassphrase: passphrase =>
      call('enableRecoveryWithPassphrase', passphrase) as Promise<string>,
    resetRecovery: () => call('resetRecovery') as Promise<string>,
    resetRecoveryWithPassphrase: passphrase =>
      call('resetRecoveryWithPassphrase', passphrase) as Promise<string>,
    recoverWithKey: key => call('recoverWithKey', key) as Promise<void>,
    requestOpenIdToken: () => call('requestOpenIdToken') as Promise<string>,

    startTokenPersistence(onTokens) {
      // The worker installed the SDK-side hook when it built the session; the
      // tab only subscribes. Nothing to ask the worker for.
      tokenListeners.add(onTokens)
    },
    startSessionSync(onChange) {
      syncListeners.add(onChange)
      // Idempotent in the worker: however many tabs call this, one loop runs.
      void call('startSessionSync').catch(err =>
        console.warn('[worker] startSessionSync failed:', err),
      )
    },
    startVerificationListener: () => call('startVerificationListener') as Promise<void>,
    pendingVerificationFlow: () =>
      call('pendingVerificationFlow') as Promise<string | undefined>,
    async verificationForFlow(flowId) {
      const handle = await client.acquireVerification(userId, flowId)
      if (!handle) return undefined
      const vcall = (method: string, ...args: Cloneable[]) =>
        client.verificationCall(handle, method, ...args)
      return {
        flowId: () => vcall('flowId') as Promise<string>,
        accept: () => vcall('accept') as Promise<void>,
        emoji: () => vcall('emoji') as Promise<string>,
        confirm: () => vcall('confirm') as Promise<void>,
        cancel: () => vcall('cancel') as Promise<void>,
        isDone: () => vcall('isDone') as Promise<boolean>,
        advance: () => vcall('advance') as Promise<string>,
        state: () => vcall('state') as Promise<string>,
      }
    },

    close() {
      unsubscribe()
      tokenListeners.clear()
      syncListeners.clear()
    },
  }
}
