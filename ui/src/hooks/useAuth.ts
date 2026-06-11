import { useState, useCallback, useContext, createContext, useRef, useEffect } from 'react'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { getWasmModule } from '../wasm/loader'
import type { OauthPopup } from '../auth/oauthPopup'

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkspaceEntry {
  id: string
  name: string
  createdAt: number
}

export interface InvitedRoom {
  id: string
  name: string
  inviter: string
}

/** A prompt the sign-in flow raises so a device is never left signed-in but
 *  unable to read history (a useless state). `save` = first device just
 *  bootstrapped backup and must store the generated recovery key; `verify` =
 *  a new device must establish trust before it can read history — by verifying
 *  with another device (SAS) or entering its master key. There is deliberately
 *  no bypass (ADR 0001 Phase D-3). */
export type RecoveryPrompt =
  | { kind: 'save'; recoveryKey: string }
  | { kind: 'verify' }
  /** Recovery bootstrap failed on a first device even after retries. This is
   *  a blocking state (not a silent warn): the account works but NO recovery
   *  key exists, so a lost device would mean unrecoverable history — the user
   *  must know. Ways forward: retry, or sign out. */
  | { kind: 'error'; message: string }

/** One of the seven SAS comparison emoji. */
export interface SasEmoji {
  symbol: string
  description: string
}

/** State of an in-progress device (SAS) verification.
 *  `role` is `self` when we asked to verify this device against another, or
 *  `incoming` when another device asked to verify with us. */
export interface VerificationState {
  role: 'self' | 'incoming'
  status: 'pending' | 'started' | 'emoji' | 'done' | 'cancelled'
  emoji: SasEmoji[]
}

/** Persisted per-account data (shared across tabs via localStorage). */
export interface AccountSession {
  homeserverUrl: string
  userId: string
  username: string
  /** Opaque JSON blob returned by MatrixSession.sessionData() */
  matrixSessionData: string
}

interface AuthState {
  // Active account state
  username: string | null
  userId: string | null
  homeserverUrl: string | null
  matrixSession: any
  workspaces: WorkspaceEntry[]
  /** True during sign-in or session restoration. */
  loading: boolean
  error: string | null

  /** Incremented whenever the session-level sync detects room list changes
   *  (new invites, new rooms, rooms left). Consumers can use this to
   *  auto-refresh workspace and invitation lists. */
  sessionSyncCount: number

  // Multi-account
  accounts: AccountSession[]
  activeAccountId: string | null

  // Actions
  signIn: (homeserver: string, user: string, password: string) => Promise<void>
  signUp: (homeserver: string, user: string, password: string) => Promise<void>
  /** Next-gen auth (MAS) sign-in via the popup flow (ADR 0002). The popup is
   *  injected: the caller must open it synchronously in its click handler —
   *  popup blockers only allow window.open during user activation. */
  signInWithOauth: (homeserver: string, popup: OauthPopup) => Promise<void>
  /** Whether the homeserver delegates auth to an OAuth authorization server
   *  (MSC3861/MAS) — drives the sign-in page's SSO-vs-password branching. */
  checkOauthSupport: (homeserver: string) => Promise<boolean>
  signOut: () => void
  createWorkspace: (name: string) => Promise<WorkspaceEntry>
  joinWorkspace: (roomId: string) => Promise<WorkspaceEntry>
  refreshWorkspaces: () => Promise<void>
  listInvitedRooms: () => Promise<InvitedRoom[]>
  acceptInvite: (roomId: string) => Promise<WorkspaceEntry>
  declineInvite: (roomId: string) => Promise<void>

  /** Start the session-level sync loop. Call this on pages where no
   *  workspace sync is running (e.g. the Workspaces page). The sync fires
   *  sessionSyncCount whenever the room list changes. */
  startSessionSync: () => void
  /** Stop the session-level sync loop (e.g. when navigating into a workspace). */
  stopSessionSync: () => void

  // Multi-account actions
  switchAccount: (userId: string) => Promise<void>
  removeAccount: (userId: string) => void

  /** Nuclear option: clear all stored data and reload the app. */
  resetApp: () => void

  /** Set when the sign-in flow needs the user to either save a freshly
   *  generated recovery key (`save`) or enter their existing one (`enter`)
   *  before they have access to encrypted workspace history. Null otherwise.
   *  See ADR 0001 Phase B / review §4.2. */
  recoveryPrompt: RecoveryPrompt | null
  /** Restore history on a new device using its saved master/recovery key.
   *  Resolves once secrets are imported; rejects (with a message) on a bad
   *  key so the gate can show an error. */
  submitRecoveryKey: (key: string) => Promise<void>
  /** Dismiss the prompt. Only meaningful for the `save` step (after the user
   *  has stored their recovery key) — the `verify` step has no bypass. */
  dismissRecoveryPrompt: () => void
  /** Retry the recovery bootstrap after a `kind: 'error'` prompt. */
  retryRecoverySetup: () => Promise<void>

  /** An in-progress device verification, or null. Drives the verify screen's
   *  emoji-compare step and the incoming-request prompt. */
  verification: VerificationState | null
  /** New device: ask to verify this device against another signed-in one
   *  (starts the SAS flow). */
  startVerification: () => Promise<void>
  /** Existing device: accept an incoming verification request and begin the
   *  emoji comparison. */
  acceptIncomingVerification: () => Promise<void>
  /** Confirm the two devices show the same emoji (both sides call this). */
  confirmVerification: () => Promise<void>
  /** Abandon the current verification (e.g. the emoji don't match). */
  cancelVerification: () => Promise<void>
}

// ── Local-storage keys ───────────────────────────────────────────────────────

const ACCOUNTS_KEY = 'collab:accounts'
const ACTIVE_ACCOUNT_KEY = 'collab:activeAccount'
const WORKSPACES_KEY = 'collab:workspaces'

// Legacy key — used for migration from single-account format
const LEGACY_SESSION_KEY = 'collab:session'

// ── Account pool (localStorage — shared across tabs) ─────────────────────────

function loadAccounts(): AccountSession[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY)
    if (raw) return JSON.parse(raw)

    // Migrate from single-account format
    const legacy = localStorage.getItem(LEGACY_SESSION_KEY)
    if (legacy) {
      const session = JSON.parse(legacy)
      if (session?.matrixSessionData) {
        const account: AccountSession = {
          homeserverUrl: session.homeserverUrl,
          userId: session.userId,
          username: session.username,
          matrixSessionData: session.matrixSessionData,
        }
        saveAccounts([account])
        localStorage.removeItem(LEGACY_SESSION_KEY)
        return [account]
      }
    }
    return []
  } catch {
    return []
  }
}

function saveAccounts(accounts: AccountSession[]) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts))
  // Clean up legacy key if it exists
  localStorage.removeItem(LEGACY_SESSION_KEY)
}

// ── Active account (sessionStorage — per-tab/window) ─────────────────────────

function loadActiveAccountId(accounts: AccountSession[]): string | null {
  try {
    const id = sessionStorage.getItem(ACTIVE_ACCOUNT_KEY)
    // Validate that the account still exists in the pool
    if (id && accounts.some(a => a.userId === id)) return id
    // Fall back to the first account
    return accounts.length > 0 ? accounts[0].userId : null
  } catch {
    return accounts.length > 0 ? accounts[0].userId : null
  }
}

function saveActiveAccountId(userId: string | null) {
  if (userId) {
    sessionStorage.setItem(ACTIVE_ACCOUNT_KEY, userId)
  } else {
    sessionStorage.removeItem(ACTIVE_ACCOUNT_KEY)
  }
}

// ── Per-account workspace storage ────────────────────────────────────────────

function workspacesKey(userId: string): string {
  return `${WORKSPACES_KEY}:${userId}`
}

function loadWorkspaces(userId: string | null): WorkspaceEntry[] {
  if (!userId) return []
  try {
    // Try per-account key first
    const perAccount = localStorage.getItem(workspacesKey(userId))
    if (perAccount) return JSON.parse(perAccount)
    // Fall back to legacy shared key
    const legacy = localStorage.getItem(WORKSPACES_KEY)
    if (legacy) return JSON.parse(legacy)
    return []
  } catch {
    return []
  }
}

function saveWorkspaces(userId: string, workspaces: WorkspaceEntry[]) {
  localStorage.setItem(workspacesKey(userId), JSON.stringify(workspaces))
}

function clearWorkspaces(userId: string) {
  localStorage.removeItem(workspacesKey(userId))
}

// ── Workspace room filtering ─────────────────────────────────────────────────

/** Parse the room list JSON and filter to only workspace-tagged rooms. */
function parseWorkspaceRooms(roomsJson: string): WorkspaceEntry[] {
  const rooms: { id: string; name: string; isWorkspace: boolean }[] = JSON.parse(roomsJson)
  return rooms
    .filter(r => r.isWorkspace)
    .map(r => ({
      id: r.id,
      name: r.name || r.id,
      createdAt: Date.now(),
    }))
}

// ── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthState | null>(null)

/** Provide auth state to the component tree. Wrap your <App> with this. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<AccountSession[]>(loadAccounts)
  const [activeAccountId, setActiveAccountId] = useState<string | null>(() => {
    const accs = loadAccounts()
    return loadActiveAccountId(accs)
  })
  const [matrixSession, setMatrixSession] = useState<any>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>(() =>
    loadWorkspaces(loadActiveAccountId(loadAccounts())),
  )
  // Start loading=true when there's a stored session to restore, so the UI
  // doesn't briefly flash the unauthenticated state before restore completes.
  const [loading, setLoading] = useState(() => {
    const accs = loadAccounts()
    const activeId = loadActiveAccountId(accs)
    return !!accs.find(a => a.userId === activeId)?.matrixSessionData
  })
  const [error, setError] = useState<string | null>(null)
  const [sessionSyncCount, setSessionSyncCount] = useState(0)
  const [recoveryPrompt, setRecoveryPrompt] = useState<RecoveryPrompt | null>(null)
  const [verification, setVerification] = useState<VerificationState | null>(null)
  // The active DeviceVerification handle (WASM) and a stopper for its loop.
  const verificationRef = useRef<any>(null)
  const verificationStopRef = useRef<(() => void) | null>(null)

  // Keep a ref so callbacks always see the latest matrixSession
  const matrixSessionRef = useRef<any>(null)

  // Track whether session-level sync is active (so we can avoid starting it twice)
  const sessionSyncActiveRef = useRef(false)

  // Track whether we've attempted auto-restore (to avoid double-restoring)
  const restoredRef = useRef(false)

  // Derive active account info
  const activeAccount = accounts.find(a => a.userId === activeAccountId) ?? null
  const username = activeAccount?.username ?? null
  const userId = activeAccount?.userId ?? null
  const homeserverUrl = activeAccount?.homeserverUrl ?? null

  // ── Helper: restore a Matrix session for an account ────────────────────────
  //
  // `initialSync()` calls the Matrix SDK's `sync_once()` which long-polls the
  // homeserver.  When another tab already holds the sync stream for the same
  // device, the server may hold the request for 30+ seconds, causing the new
  // tab to hang.  We race it against a short timeout so the UI can proceed.
  // The session is still fully usable — `ConnectedWorkspace.create()` may need
  // to retry until the SDK cache is populated.
  const restoreSession = useCallback(async (account: AccountSession) => {
    console.log('[auth] Loading WASM module...')
    const wasm = await getWasmModule()
    console.log('[auth] WASM loaded, restoring Matrix session for', account.userId)

    // Race MatrixSession.restore() against a timeout.  The Rust side builds
    // a Client (connects to homeserver) and calls restore_session — both are
    // async and can hang if the homeserver is unreachable or slow.
    const RESTORE_TIMEOUT_MS = 10_000
    const restorePromise = wasm.MatrixSession.restore(
      account.homeserverUrl,
      account.matrixSessionData,
    )
    const restoreTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('MatrixSession.restore() timed out')), RESTORE_TIMEOUT_MS),
    )
    const ms = await Promise.race([restorePromise, restoreTimeout])
    console.log('[auth] Matrix session restored, running initialSync...')

    // Race initialSync against a 5-second timeout.  If it loses, we still
    // return the session and let initialSync finish in the background.
    const SYNC_TIMEOUT_MS = 5_000
    const syncDone = ms.initialSync()
    const timeout = new Promise<'timeout'>(resolve =>
      setTimeout(() => resolve('timeout'), SYNC_TIMEOUT_MS),
    )

    const result = await Promise.race([
      syncDone.then(() => 'ok' as const),
      timeout,
    ])

    if (result === 'timeout') {
      console.warn(
        '[auth] initialSync timed out (another tab may hold the sync stream). ' +
        'Continuing with cached session — workspace init will retry.',
      )
      // Let it finish in the background (populates SDK room cache)
      syncDone.catch((err: any) => console.warn('[auth] Background initialSync failed:', err))
    } else {
      console.log('[auth] initialSync completed')
    }

    return ms
  }, [])

  // ── Recovery gate ──────────────────────────────────────────────────────────
  //
  // A device that's signed in but can't decrypt history is a useless state, so
  // after every sign-in we steer it into a good one: the FIRST device
  // bootstraps Secure Backup + Recovery (and we surface the generated key for
  // the user to save), while a RETURNING device (a backup exists but this
  // device lacks the keys) is prompted to restore with its saved key. A device
  // that already has the keys ("ready") sails through. See ADR 0001 Phase B.
  // Bootstrap recovery on a FIRST device, retrying transient failures with
  // backoff. If every attempt fails, raise a **blocking** error prompt — never
  // silence: the account works but no recovery key exists, so the user must
  // know (the old console.warn fail-open silently produced devices whose
  // history could never be restored).
  const bootstrapRecovery = useCallback(async (ms: any) => {
    const retryDelaysMs = [0, 2000, 5000]
    let lastErr: unknown
    for (const delay of retryDelaysMs) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
      try {
        const recoveryKey: string = await ms.enableRecovery()
        setRecoveryPrompt({ kind: 'save', recoveryKey })
        return
      } catch (err) {
        lastErr = err
        console.warn('[auth] Recovery bootstrap attempt failed:', err)
      }
    }
    setRecoveryPrompt({
      kind: 'error',
      message: (lastErr as Error)?.message ?? String(lastErr ?? 'Unknown error'),
    })
  }, [])

  /** Retry the recovery bootstrap from the `kind: 'error'` screen. */
  const retryRecoverySetup = useCallback(async () => {
    const ms = matrixSessionRef.current
    if (!ms) return
    setRecoveryPrompt(null)
    await bootstrapRecovery(ms)
  }, [bootstrapRecovery])

  const ensureHistoryAccess = useCallback(
    async (ms: any) => {
      try {
        // Guard for mocks / older WASM bindings without the recovery surface.
        if (typeof ms.recoveryStatus !== 'function') return
        // The SDK reports "unknown" until its backup/recovery subsystem settles
        // after sync — treat that as "not yet", not "nothing to do". Without
        // this, a slow-settling flow (observed with OAuth's extra round-trips)
        // silently skips the recovery bootstrap on a first device.
        let status = 'unknown'
        for (let attempt = 0; attempt < 30 && status === 'unknown'; attempt++) {
          status = await ms.recoveryStatus()
          if (status === 'unknown') await new Promise(r => setTimeout(r, 500))
        }
        if (status === 'unknown') {
          console.warn('[auth] Recovery state never settled — no recovery prompt shown')
        }
        if (status === 'needs_bootstrap') {
          await bootstrapRecovery(ms)
        } else if (status === 'needs_recovery') {
          // New device: must verify (or use its master key) before it can read
          // history. No bypass — only verifying or signing out moves forward.
          setRecoveryPrompt({ kind: 'verify' })
        }
      } catch (err) {
        // Only the status *probe* fails open (we can't tell a first device
        // from a returning one here, and a returning device is covered by the
        // verify gate + undecryptable-history banner). Bootstrap failures are
        // handled above and always surface.
        console.warn('[auth] Recovery check failed:', err)
      }
    },
    [bootstrapRecovery],
  )

  const submitRecoveryKey = useCallback(async (key: string) => {
    const ms = matrixSessionRef.current
    if (!ms) throw new Error('Not signed in')
    await ms.recoverWithKey(key)
    // Re-sync so the SDK downloads room keys from backup and history decrypts.
    try {
      await ms.initialSync()
    } catch {
      // Non-fatal — keys download in the background; the next sync picks up.
    }
    setRecoveryPrompt(null)
  }, [])

  const dismissRecoveryPrompt = useCallback(() => {
    setRecoveryPrompt(null)
  }, [])

  // ── Device verification (SAS) driver ───────────────────────────────────────
  //
  // Drives a DeviceVerification handle to completion by repeatedly advancing it
  // (one protocol step) and mirroring its state into React. A `self` flow (this
  // new device asked to verify) pumps its own bounded sync, since no continuous
  // sync runs on the gated verify screen; an `incoming` flow relies on the sync
  // already running in the app. On `done`, the device is trusted and gets its
  // keys, so we clear the gate and re-sync. (ADR 0001 Phase D-3.)
  const runVerificationLoop = useCallback((handle: any, role: 'self' | 'incoming') => {
    verificationStopRef.current?.()
    let stopped = false
    verificationStopRef.current = () => {
      stopped = true
    }

    const tick = async () => {
      if (stopped) return
      try {
        if (role === 'self') {
          try {
            await matrixSessionRef.current?.pumpSync()
          } catch {
            /* a missed sync just means another iteration */
          }
        }
        const status: string = await handle.advance()
        let emoji: SasEmoji[] = []
        try {
          emoji = JSON.parse(handle.emoji() || '[]')
        } catch {
          /* emoji not ready */
        }
        setVerification({ role, status: status as VerificationState['status'], emoji })

        if (status === 'done') {
          stopped = true
          setRecoveryPrompt(null)
          // Pull the secrets/keys that verification just unlocked.
          try {
            await matrixSessionRef.current?.initialSync()
          } catch {
            /* keys arrive on the next sync */
          }
          // Show the "verified" confirmation briefly, then close the screen.
          setTimeout(() => {
            verificationRef.current = null
            setVerification(null)
          }, 1500)
          return
        }
        if (status === 'cancelled') {
          stopped = true
          verificationRef.current = null
          setVerification(null)
          return
        }
      } catch (err) {
        console.warn('[verify] loop error:', err)
      }
      if (!stopped) setTimeout(tick, 800)
    }

    tick()
  }, [])

  const startVerification = useCallback(async () => {
    const ms = matrixSessionRef.current
    if (!ms || typeof ms.requestSelfVerification !== 'function') {
      throw new Error('Verification is not available')
    }
    const handle = await ms.requestSelfVerification()
    verificationRef.current = handle
    setVerification({ role: 'self', status: 'pending', emoji: [] })
    runVerificationLoop(handle, 'self')
  }, [runVerificationLoop])

  const acceptIncomingVerification = useCallback(async () => {
    const handle = verificationRef.current
    if (!handle) return
    await handle.accept()
    runVerificationLoop(handle, 'incoming')
  }, [runVerificationLoop])

  const confirmVerification = useCallback(async () => {
    await verificationRef.current?.confirm()
  }, [])

  const cancelVerification = useCallback(async () => {
    const handle = verificationRef.current
    verificationStopRef.current?.()
    verificationRef.current = null
    setVerification(null)
    try {
      await handle?.cancel()
    } catch {
      /* best effort */
    }
  }, [])

  // Detect INCOMING verification requests (e.g. another of our devices asking
  // to verify). The listener records requests while a sync runs in the app; we
  // poll the drained flow id and surface the accept prompt.
  useEffect(() => {
    const ms = matrixSession
    if (!ms || typeof ms.startVerificationListener !== 'function') return
    ms.startVerificationListener()
    const id = setInterval(async () => {
      if (verificationRef.current) return
      try {
        const flow: string | undefined = ms.pendingVerificationFlow?.()
        if (flow) {
          const handle = await ms.verificationForFlow(flow)
          if (handle) {
            verificationRef.current = handle
            setVerification({ role: 'incoming', status: 'pending', emoji: [] })
          }
        }
      } catch {
        /* ignore */
      }
    }, 2500)
    return () => clearInterval(id)
  }, [matrixSession])

  // ── Auto-restore session on mount ──────────────────────────────────────────
  //
  // Note: We intentionally use an empty dependency array and guard with
  // `restoredRef` so this only runs once, even in React Strict Mode.
  // Strict Mode calls cleanup between its double-mount, which would set a
  // `cancelled` flag and cause the async work to silently discard its result
  // — that was the root cause of the "Connecting..." hang on duplicate tabs.
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true

    const accs = loadAccounts()
    const activeId = loadActiveAccountId(accs)
    const account = accs.find(a => a.userId === activeId)
    console.log('[auth] Auto-restore: activeId =', activeId, ', account found =', !!account?.matrixSessionData)
    if (!account?.matrixSessionData) {
      console.log('[auth] No session data to restore, skipping')
      return
    }

    setLoading(true)

    ;(async () => {
      try {
        console.log('[auth] Starting session restore for', account.username)
        const ms = await restoreSession(account)

        console.log('[auth] Session restore complete, setting matrixSession')
        matrixSessionRef.current = ms
        setMatrixSession(ms)

        // Restored device: if a backup exists but this device lacks the keys,
        // prompt to restore so reload isn't a no-history dead end.
        await ensureHistoryAccess(ms)

        // Refresh workspace list from server.
        // If initialSync timed out, listRooms may return an empty list
        // because the SDK cache is empty. In that case, keep the locally
        // cached workspaces so the user can still navigate.
        try {
          const roomsJson = await ms.listRooms()
          const entries = parseWorkspaceRooms(roomsJson)
          console.log('[auth] listRooms returned', entries.length, 'workspaces')
          if (entries.length > 0) {
            setWorkspaces(entries)
            saveWorkspaces(account.userId, entries)
          }
        } catch (listErr) {
          console.warn('[auth] listRooms failed after restore (sync may still be running):', listErr)
        }
      } catch (err: any) {
        console.error('[auth] Session restore failed:', err)
        // Don't remove the account on timeout — only on auth errors.
        // A timeout just means the server is slow, not that creds are bad.
        const isTimeout = err?.message?.includes('timed out')
        if (isTimeout) {
          console.warn('[auth] Restore timed out, keeping account but clearing loading state')
          setError('Connection to homeserver is slow. You may need to reload.')
        } else {
          // Remove the stale account from the pool
          const updated = accs.filter(a => a.userId !== account.userId)
          saveAccounts(updated)
          setAccounts(updated)
          clearWorkspaces(account.userId)
          // Switch to next account or clear
          const nextId = updated.length > 0 ? updated[0].userId : null
          setActiveAccountId(nextId)
          saveActiveAccountId(nextId)
          setWorkspaces(nextId ? loadWorkspaces(nextId) : [])
          setError('Session expired. Please sign in again.')
        }
      } finally {
        console.log('[auth] Restore flow finished, setting loading=false')
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Shared sign-in completion ──────────────────────────────────────────────
  // Everything after "we have a logged-in MatrixSession", identical across
  // password sign-in, registration, and OAuth: persist the account (the
  // session blob is opaque — it carries its own kind + store name), activate
  // it, load workspaces, and steer the device into a history-capable state.
  const completeSignIn = useCallback(
    async (ms: any, homeserver: string, usernameHint: string) => {
      const uid = ms.userId() ?? `@${usernameHint}:unknown`

      // Persist full session data including tokens
      const matrixSessionData: string = ms.sessionData()

      const account: AccountSession = {
        homeserverUrl: homeserver,
        userId: uid,
        username: usernameHint,
        matrixSessionData,
      }

      // Add or update in the account pool
      setAccounts(prev => {
        const updated = prev.filter(a => a.userId !== uid)
        updated.push(account)
        saveAccounts(updated)
        return updated
      })

      // Set as active for this window
      setActiveAccountId(uid)
      saveActiveAccountId(uid)

      matrixSessionRef.current = ms
      setMatrixSession(ms)

      // Populate workspace list from joined rooms (filtered)
      const roomsJson = await ms.listRooms()
      const entries = parseWorkspaceRooms(roomsJson)
      setWorkspaces(entries)
      saveWorkspaces(uid, entries)

      // Never land in a signed-in-but-no-history state: bootstrap recovery
      // on a first device, or prompt to restore on a returning one.
      await ensureHistoryAccess(ms)
    },
    [ensureHistoryAccess],
  )

  // ── signIn: add or update an account in the pool ───────────────────────────
  const signIn = useCallback(
    async (homeserver: string, user: string, password: string) => {
      setLoading(true)
      setError(null)

      try {
        const wasm = await getWasmModule()
        const ms = await wasm.MatrixSession.login(homeserver, user, password)
        await ms.initialSync()
        await completeSignIn(ms, homeserver, user)
      } catch (err: any) {
        const msg = err?.message ?? String(err)
        setError(msg)
        throw new Error(msg)
      } finally {
        setLoading(false)
      }
    },
    [completeSignIn],
  )

  // ── signInWithOauth: next-gen auth (MAS) via the popup flow ────────────────
  const signInWithOauth = useCallback(
    async (homeserver: string, popup: OauthPopup) => {
      setLoading(true)
      setError(null)

      try {
        const wasm = await getWasmModule()
        // Dynamic client registration + authorization URL; the PKCE verifier
        // stays in this page's WASM client, which is why the popup (not a
        // full-page redirect) carries the user through MAS.
        const authUrl: string = await wasm.MatrixSession.startOauthLogin(
          homeserver,
          `${window.location.origin}/oauth/callback`,
        )
        popup.navigate(authUrl)
        const redirectedUrl = await popup.waitForCallback()

        const ms = await wasm.MatrixSession.finishOauthLogin(redirectedUrl)
        await ms.initialSync()

        const uid: string = ms.userId() ?? ''
        const usernameHint = uid.startsWith('@') ? uid.slice(1).split(':')[0] : uid
        await completeSignIn(ms, homeserver, usernameHint)
      } catch (err: any) {
        popup.close()
        const msg = err?.message ?? String(err)
        setError(msg)
        throw new Error(msg)
      } finally {
        setLoading(false)
      }
    },
    [completeSignIn],
  )

  // ── checkOauthSupport: does this homeserver use next-gen auth? ─────────────
  const checkOauthSupport = useCallback(async (homeserver: string): Promise<boolean> => {
    try {
      const wasm = await getWasmModule()
      return await wasm.MatrixSession.homeserverSupportsOauth(homeserver)
    } catch {
      // Unreachable server / no WASM — the password form is the safe default.
      return false
    }
  }, [])

  // ── signUp: register a new account and log in ────────────────────────────────
  const signUp = useCallback(
    async (homeserver: string, user: string, password: string) => {
      setLoading(true)
      setError(null)

      try {
        const wasm = await getWasmModule()
        const ms = await wasm.MatrixSession.register(homeserver, user, password)
        await ms.initialSync()
        await completeSignIn(ms, homeserver, user)
      } catch (err: any) {
        const msg = err?.message ?? String(err)
        setError(msg)
        throw new Error(msg)
      } finally {
        setLoading(false)
      }
    },
    [completeSignIn],
  )

  // ── signOut: remove the active account from the pool ───────────────────────
  const signOut = useCallback(() => {
    const currentId = activeAccountId

    setAccounts(prev => {
      const updated = currentId ? prev.filter(a => a.userId !== currentId) : []
      saveAccounts(updated)

      // Switch to next account if available
      const nextId = updated.length > 0 ? updated[0].userId : null
      setActiveAccountId(nextId)
      saveActiveAccountId(nextId)

      if (currentId) clearWorkspaces(currentId)

      if (nextId) {
        setWorkspaces(loadWorkspaces(nextId))
        // Trigger restore for the new active account on next render
      } else {
        setWorkspaces([])
      }

      return updated
    })

    matrixSessionRef.current = null
    setMatrixSession(null)
    setError(null)
    // Don't clear wasm module — other accounts may still need it
  }, [activeAccountId])

  // ── switchAccount: change which account is active in this window ────────────
  const switchAccount = useCallback(
    async (targetUserId: string) => {
      const account = accounts.find(a => a.userId === targetUserId)
      if (!account) throw new Error(`Account ${targetUserId} not found`)
      if (targetUserId === activeAccountId && matrixSessionRef.current) return

      setLoading(true)
      setError(null)
      matrixSessionRef.current = null
      setMatrixSession(null)

      setActiveAccountId(targetUserId)
      saveActiveAccountId(targetUserId)
      setWorkspaces(loadWorkspaces(targetUserId))

      try {
        const ms = await restoreSession(account)

        matrixSessionRef.current = ms
        setMatrixSession(ms)

        await ensureHistoryAccess(ms)

        // Refresh workspaces from server
        const roomsJson = await ms.listRooms()
        const entries = parseWorkspaceRooms(roomsJson)
        setWorkspaces(entries)
        saveWorkspaces(targetUserId, entries)
      } catch (err: any) {
        console.error('Switch account failed:', err)
        setError(`Failed to restore session for ${account.username}: ${err.message}`)
      } finally {
        setLoading(false)
      }
    },
    [accounts, activeAccountId, restoreSession, ensureHistoryAccess],
  )

  // ── removeAccount: remove a specific account from the pool ─────────────────
  const removeAccount = useCallback(
    (targetUserId: string) => {
      setAccounts(prev => {
        const updated = prev.filter(a => a.userId !== targetUserId)
        saveAccounts(updated)
        return updated
      })
      clearWorkspaces(targetUserId)

      // If we removed the active account, switch to another or clear
      if (targetUserId === activeAccountId) {
        const remaining = accounts.filter(a => a.userId !== targetUserId)
        const nextId = remaining.length > 0 ? remaining[0].userId : null

        setActiveAccountId(nextId)
        saveActiveAccountId(nextId)
        matrixSessionRef.current = null
        setMatrixSession(null)
        setWorkspaces(nextId ? loadWorkspaces(nextId) : [])
      }
    },
    [accounts, activeAccountId],
  )

  // ── createWorkspace ────────────────────────────────────────────────────────
  const createWorkspace = useCallback(
    async (name: string): Promise<WorkspaceEntry> => {
      const ms = matrixSessionRef.current
      if (!ms) throw new Error('Not signed in')
      const roomId: string = await ms.createRoom(name)
      const entry: WorkspaceEntry = { id: roomId, name, createdAt: Date.now() }
      setWorkspaces(prev => {
        const next = [...prev, entry]
        if (activeAccountId) saveWorkspaces(activeAccountId, next)
        return next
      })
      return entry
    },
    [activeAccountId],
  )

  // ── joinWorkspace ──────────────────────────────────────────────────────────
  const joinWorkspace = useCallback(
    async (roomId: string): Promise<WorkspaceEntry> => {
      const ms = matrixSessionRef.current
      if (!ms) throw new Error('Not signed in')
      await ms.joinRoom(roomId)
      await ms.initialSync()
      const roomsJson = await ms.listRooms()
      const rooms: { id: string; name: string }[] = JSON.parse(roomsJson)
      const room = rooms.find(r => r.id === roomId)
      const entry: WorkspaceEntry = {
        id: roomId,
        name: room?.name || roomId,
        createdAt: Date.now(),
      }
      setWorkspaces(prev => {
        if (prev.some(w => w.id === roomId)) return prev
        const next = [...prev, entry]
        if (activeAccountId) saveWorkspaces(activeAccountId, next)
        return next
      })
      return entry
    },
    [activeAccountId],
  )

  // ── refreshWorkspaces ──────────────────────────────────────────────────────
  //
  // When the session sync loop is active (sessionSyncActiveRef is true), the
  // SDK cache is already being maintained by the continuous sync — calling
  // initialSync() would compete for the sync token.  In that case, just
  // re-read the room list.
  const refreshWorkspaces = useCallback(async () => {
    const ms = matrixSessionRef.current
    if (!ms) return
    try {
      if (!sessionSyncActiveRef.current) {
        await ms.initialSync()
      }
      const roomsJson = await ms.listRooms()
      const entries = parseWorkspaceRooms(roomsJson)
      setWorkspaces(entries)
      if (activeAccountId) saveWorkspaces(activeAccountId, entries)
    } catch (err) {
      console.error('Failed to refresh workspaces:', err)
    }
  }, [activeAccountId])

  // ── listInvitedRooms: fetch pending invitations from Matrix ────────────────
  const listInvitedRooms = useCallback(async (): Promise<InvitedRoom[]> => {
    const ms = matrixSessionRef.current
    if (!ms) return []
    try {
      const json = await ms.listInvitedRooms()
      return JSON.parse(json) as InvitedRoom[]
    } catch (err) {
      console.error('Failed to list invited rooms:', err)
      return []
    }
  }, [])

  // ── acceptInvite: join an invited room and add it to workspaces ────────────
  const acceptInvite = useCallback(
    async (roomId: string): Promise<WorkspaceEntry> => {
      const ms = matrixSessionRef.current
      if (!ms) throw new Error('Not signed in')

      // Joining an invited room is how you accept in Matrix
      await ms.joinRoom(roomId)

      // Re-sync so the SDK knows about the newly joined room
      try {
        await ms.initialSync()
      } catch {
        // Non-fatal — the room may still be usable from cache
      }

      // Look up the room name from the room list
      let roomName = roomId
      try {
        const roomsJson = await ms.listRooms()
        const rooms: { id: string; name: string }[] = JSON.parse(roomsJson)
        const room = rooms.find(r => r.id === roomId)
        if (room?.name) roomName = room.name

        // Refresh the full workspace list while we have it
        const entries = parseWorkspaceRooms(roomsJson)
        setWorkspaces(entries)
        if (activeAccountId) saveWorkspaces(activeAccountId, entries)
      } catch {
        // Fall back to just adding this room
      }

      const entry: WorkspaceEntry = {
        id: roomId,
        name: roomName,
        createdAt: Date.now(),
      }

      // Ensure this room is in our workspace list
      setWorkspaces(prev => {
        if (prev.some(w => w.id === roomId)) return prev
        const next = [...prev, entry]
        if (activeAccountId) saveWorkspaces(activeAccountId, next)
        return next
      })

      return entry
    },
    [activeAccountId],
  )

  // ── declineInvite: leave an invited room ───────────────────────────────────
  const declineInvite = useCallback(async (roomId: string): Promise<void> => {
    const ms = matrixSessionRef.current
    if (!ms) throw new Error('Not signed in')
    await ms.declineInvite(roomId)
  }, [])

  // ── startSessionSync / stopSessionSync ──────────────────────────────────────
  //
  // Starts a Matrix sync loop on the MatrixSession that fires whenever the
  // room list changes (new invites, new rooms joined, rooms left).  This is
  // used on the Workspaces page where no ConnectedWorkspace sync is running.
  //
  // Important: only ONE sync loop should run per Client at a time.  When a
  // ConnectedWorkspace.startSync is active (inside a workspace), do NOT call
  // startSessionSync — they share the same Client and would compete for the
  // sync stream.
  const startSessionSync = useCallback(() => {
    const ms = matrixSessionRef.current
    if (!ms || sessionSyncActiveRef.current) return
    if (!ms.startSessionSync) {
      console.warn('[auth] startSessionSync not available on MatrixSession (mock?)')
      return
    }

    console.log('[auth] Starting session-level sync')
    sessionSyncActiveRef.current = true

    ms.startSessionSync(() => {
      console.log('[session-sync] Room list changed, triggering refresh')
      setSessionSyncCount(c => c + 1)
    })
  }, [])

  const stopSessionSync = useCallback(() => {
    // The sync loop runs inside a WASM spawn_local — we can't cancel it
    // directly.  Instead we mark it as inactive so we don't start a second
    // one.  The sync loop is tied to the Client lifetime and will stop when
    // the MatrixSession is dropped (on sign-out / account switch).
    sessionSyncActiveRef.current = false
  }, [])

  // ── resetApp: clear everything and reload ─────────────────────────────────
  const resetApp = useCallback(() => {
    // Clear all collab-related localStorage keys
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('collab:')) keysToRemove.push(key)
    }
    keysToRemove.forEach(k => localStorage.removeItem(k))

    // Also clear legacy key
    localStorage.removeItem(LEGACY_SESSION_KEY)

    // Clear sessionStorage
    sessionStorage.removeItem(ACTIVE_ACCOUNT_KEY)

    // Reload the page to get a clean state
    window.location.replace('/signin')
  }, [])

  const value: AuthState = {
    username,
    userId,
    homeserverUrl,
    matrixSession,
    workspaces,
    loading,
    error,
    sessionSyncCount,
    accounts,
    activeAccountId,
    signIn,
    signUp,
    signInWithOauth,
    checkOauthSupport,
    signOut,
    createWorkspace,
    joinWorkspace,
    refreshWorkspaces,
    listInvitedRooms,
    acceptInvite,
    declineInvite,
    startSessionSync,
    stopSessionSync,
    switchAccount,
    removeAccount,
    resetApp,
    recoveryPrompt,
    submitRecoveryKey,
    dismissRecoveryPrompt,
    retryRecoverySetup,
    verification,
    startVerification,
    acceptIncomingVerification,
    confirmVerification,
    cancelVerification,
  }

  return createElement(AuthContext.Provider, { value }, children)
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/** Consume auth state from the nearest AuthProvider. */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return ctx
}
