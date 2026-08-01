import { useState, useCallback, useContext, createContext, useRef, useEffect } from 'react'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { getWasmModule } from '../wasm/loader'
import type { OauthPopup } from '../auth/oauthPopup'
import {
  hasPlatformAuthenticator,
  registerPasskeyPrf,
  unlockPasskeyPrf,
} from '../auth/passkeyPrf'
import { sharedWorkerEnabled } from '../worker/flag'
import { connectWorker } from '../worker/client'
import { openWorkerSession } from '../worker/workerSession'
import {
  deriveAtRestKeys,
  encryptString,
  decryptString,
  generateDataKey,
  deriveStorePassphraseFromDataKey,
  deriveAtRestKeysFromDataKey,
  wrapDataKey,
  unwrapDataKey,
  type AtRestKeys,
} from '../lib/atRestCrypto'
import { getOrCreateDeviceKey, getDeviceKey, clearDeviceKey } from '../lib/deviceKey'
import { setSnapshotKey, getSnapshotKey } from '../lib/atRestSession'
import {
  addPasskeyWrap,
  loadWrapRecord,
  saveWrapRecord,
  emptyWrapRecord,
  unwrapRecoveryKey,
  hasEnrolledPasskey,
  parseWrapRecord,
} from '../lib/passkeyWrap'
import { retireStore } from '../lib/storeReaper'
import { fetchCheckoutUrl, fetchPortalUrl, requestAccountDeletion } from '../lib/billing'
import { isSessionRejected } from '../lib/authErrors'

/** How long a post-recovery `initialSync` may hold up the UI before it is
 *  demoted to the background (issue 58dfe52b: on a large account that sync
 *  covers every joined room and kept the verify/unlock gate up for its full
 *  duration). Keys that arrive later decrypt on the next sync. */
const POST_RECOVERY_SYNC_TIMEOUT_MS = 3_000

/** Run one `initialSync`, awaiting it only up to `timeoutMs`; past that it
 *  finishes in the background. Returns the underlying sync promise wrapped in
 *  an object (so `await` doesn't collapse it; it never rejects — failures are
 *  logged) for chaining "once it truly lands" work. */
async function syncBounded(
  ms: { initialSync(): Promise<unknown> },
  timeoutMs: number,
  label: string,
): Promise<{ done: Promise<void> }> {
  const t0 = performance.now()
  const done = ms.initialSync().then(
    () => console.log(`[auth] ${label} completed in ${Math.round(performance.now() - t0)}ms`),
    (err: unknown) => console.warn(`[auth] ${label} failed:`, err),
  )
  const timedOut = await Promise.race([
    done.then(() => false),
    new Promise<true>(resolve => setTimeout(() => resolve(true), timeoutMs)),
  ])
  if (timedOut) {
    console.warn(`[auth] ${label} still running after ${timeoutMs}ms — continuing without it`)
  }
  return { done }
}

/**
 * Build a Matrix session — in the SharedWorker, which is the normal path
 * (issue 87bf86a6, stage 4).
 *
 * ONE seam for all five ways a session comes into being (restore, sign-in,
 * register, OAuth, and the re-key that logs in again), so there is no route by
 * which a tab quietly ends up with a client of its own.
 *
 * `expectUserId` is the whole point and is known for every RESTORE: it lets the
 * worker hand back the client another tab already built, without touching the
 * shared crypto store. Login/register/OAuth cannot know it up front and are
 * deduped after the fact.
 *
 * If the worker cannot be reached this THROWS rather than quietly building an
 * in-tab client. That fallback existed and was removed: it handed the user back
 * the exact bug — a second tab whose writes vanish with no error — in the
 * situations least likely to be noticed. The in-tab path remains only behind an
 * explicit `?sharedWorker=0` override, for debugging.
 */
async function buildSession(
  via: 'login' | 'register' | 'restore' | 'finishOauthLogin',
  args: Array<string | undefined>,
  expectUserId?: string,
): Promise<any> {
  if (sharedWorkerEnabled()) {
    const worker = await connectWorker()
    const session = await openWorkerSession(worker, via, args, expectUserId)
    if (session.joined()) {
      console.log('[auth] attached to the shared worker’s existing client for', session.userId())
    }
    return session
  }
  const wasm = await getWasmModule()
  return await wasm.MatrixSession[via](...args)
}

/**
 * A static `MatrixSession` method, routed the same way `buildSession` routes the
 * factories.
 *
 * This is not optional for `startOauthLogin`: it stashes the PKCE verifier in the
 * client that issued it, and `finishOauthLogin` must find it there. Starting the
 * flow in the tab and finishing it in the worker would fail the code exchange —
 * the two must be the same client.
 */
async function staticSessionCall(method: string, ...args: string[]): Promise<any> {
  if (sharedWorkerEnabled()) {
    return await (await connectWorker()).staticCall(method, ...args)
  }
  const wasm = await getWasmModule()
  return await wasm.MatrixSession[method](...args)
}

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
  /** After the key is saved: offer a passkey as a faster way to unlock. Purely
   *  additive — it wraps `recoveryKey` rather than replacing it, so declining
   *  or failing changes nothing about the account. (issue 63dc1339) */
  | { kind: 'speedup'; recoveryKey: string }
  /** A legacy passkey-custody account whose master secret is the PRF output and
   *  which therefore has a key the user has never seen. Prompt them to reveal
   *  and save it, so losing the passkey stops meaning losing the account. */
  | { kind: 'save-legacy-key' }
  /** Save the recovery key. `viaPasskey` means a passkey already unlocks this
   *  account, so the key is a break-glass backup rather than the only way in. */
  | { kind: 'save'; recoveryKey: string; viaPasskey?: boolean }
  | { kind: 'verify' }
  /** Unlock-first cold start (issue c72ec5df): an at-rest-encrypted (v2) session
   *  needs the master secret BEFORE the encrypted SDK store can be opened, so
   *  restore is gated behind a passkey touch ('passkey') or a typed recovery key
   *  ('manual'). `custody` picks the default UI; both paths stay available. */
  | { kind: 'unlock'; custody?: 'passkey' | 'manual' }
  /** A legacy account (raw recovery key) just unlocked with its master key on a
   *  passkey-capable device — offer to protect it with a passkey so future
   *  devices need no typed key. Optional: declining proceeds into the app. */
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

/** Persisted per-account data (shared across tabs via localStorage).
 *
 * At-rest encryption (issue c72ec5df): v2 entries hold the session blob
 * AES-GCM-encrypted (`secrets`) under a master-key-derived key; the SDK store is
 * likewise encrypted. v1 (no `v`) is the legacy PLAINTEXT format — purged on
 * load by the hard cutover (the user re-logs in once, producing a v2 entry). */
export interface AccountSession {
  homeserverUrl: string
  userId: string
  username: string
  /** Format version. Absent = legacy v1 (plaintext `matrixSessionData`). */
  v?: 2
  /**
   * The at-rest DATA key, sealed two ways (issue 8509dc68). Everything at rest —
   * the SDK store, this session blob, the workspace snapshot — is keyed by the
   * data key; these are the two ways to get it back.
   *
   * `deviceKeyWrap` is under this browser's non-extractable device key, so a
   * page load opens the store with NO user interaction. That is what makes at-rest
   * usable: the alternative is typing a recovery key on every refresh.
   *
   * `dataKeyWrap` is under the master secret, so a NEW device (or this one after
   * its device key is gone) can still get in. Losing the browser profile is then
   * recoverable rather than fatal.
   */
  deviceKeyWrap?: string
  dataKeyWrap?: string
  /** v2: which unlock method the account uses (drives the unlock gate UI). */
  custody?: 'passkey' | 'manual'
  /** The user has confirmed they saved their master key. Legacy passkey-custody
   *  accounts predate this and are prompted once to save theirs (63dc1339). */
  keySaved?: boolean
  /**
   * A LOCAL copy of the passkey wrap record (the same JSON stored in account
   * data). Duplicated on purpose: at-rest cold start is circular otherwise —
   * reading account data needs a client, a client needs the encrypted store, and
   * the store needs the master secret the wrap contains. This copy breaks the
   * cycle. The account-data copy is still the portable one a NEW device reads.
   *
   * Ciphertext, so it is no more sensitive at rest than `secrets`.
   */
  passkeyWrap?: string
  /**
   * This device's IndexedDB store for the account (`tw-<user>-<millis>`).
   *
   * Recorded in PLAINTEXT, deliberately. It is also inside the session blob,
   * but for a v2 account that blob is encrypted — so an account that is signed
   * out, or removed while another one is active, has a store whose name nothing
   * can read, and it is orphaned forever. The name is a sanitized username plus
   * a timestamp; the contents stay encrypted, and it is already discoverable
   * via `indexedDB.databases()`. See lib/storeReaper.ts.
   */
  storeName?: string
  /** v1 only: opaque JSON blob from MatrixSession.sessionData() (PLAINTEXT). */
  matrixSessionData?: string
  /** v2 only: AES-GCM(tokenKey) over the sessionData() blob (base64url). */
  secrets?: string
}

/**
 * A workspace the reset flow has to dispose of (issue 63dc1339 stage 4).
 *
 * `others` is what makes the decision possible: with members present the
 * workspace can be handed on, and without them there is nobody to hand it to.
 */
export interface ResettableWorkspace {
  id: string
  name: string
  /** Whether this user can delete it / change roles at all. */
  amAdmin: boolean
  /** Active members other than this user. */
  others: Array<{ id: string; label: string; role: string }>
}

/** What to do with one workspace during a reset. */
export type ResetPlan =
  /** Promote `successor` to admin, then leave. The workspace and its data
   *  survive for everyone else. */
  | { id: string; action: 'handoff'; successor: string }
  /** Remove every member and leave — the workspace is gone. The only option
   *  when nobody else is in it. */
  | { id: string; action: 'delete' }

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

  /** Delete this account permanently: cancels any subscription, then
   *  deactivates and erases it server-side. Throws with a user-facing message
   *  on failure, leaving the session intact so it can be retried. */
  deleteAccount: () => Promise<void>

  /**
   * What a full account reset would have to deal with, per workspace (issue
   * 63dc1339 stage 4). Read BEFORE resetting so the user decides each
   * workspace's fate explicitly rather than discovering it afterwards.
   */
  listResettableWorkspaces: () => Promise<ResettableWorkspace[]>
  /**
   * The nuclear option, for a user who cannot verify at all: carry out `plan`
   * (hand each workspace to a successor, or delete it), then rotate secret
   * storage to a fresh key and return that key.
   *
   * IRREVERSIBLE. Everything encrypted under the old key becomes unreadable, so
   * this is the way out of a dead end, not a tidy-up.
   */
  resetAccount: (plan: ResetPlan[]) => Promise<string>

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

  /** Whether passkey (WebAuthn-PRF) unlock is available in this browser. Gates
   *  the passkey options in the recovery/verify screens. */
  passkeyAvailable: boolean
  /** Whether the *account* has a passkey enrolled (secure backup is keyed by a
   *  passphrase, i.e. our passkey PRF). With `passkeyAvailable`, gates the
   *  "Unlock with passkey" option on the verify gate — legacy accounts (raw
   *  recovery key) are never offered a passkey they don't have. */
  passkeyEnrolled: boolean
  /** `speedup` prompt: enrol a passkey that unlocks WITHOUT replacing the
   *  recovery key — it wraps it. Throws on a PRF-less provider, which is safe
   *  to surface because nothing about the account has changed. */
  addPasskeySpeedup: (recoveryKey: string) => Promise<void>
  /** `save` prompt: the user confirmed they stored the key. Moves on to the
   *  optional passkey step (or straight into the app without passkeys). */
  confirmKeySaved: (recoveryKey: string) => Promise<void>
  /** `save-legacy-key` prompt: reveal a legacy passkey account's master secret
   *  so the user can finally save it. Requires a passkey gesture — the tap IS
   *  the re-auth, and nothing is retained afterwards. */
  revealLegacyKey: () => Promise<string>
  /** Record that the master key has been saved, so the prompt does not return. */
  markKeySaved: () => void
  /** New device (`verify` prompt): unlock history with the account's passkey
   *  instead of typing the master key. */
  unlockWithPasskey: () => Promise<void>
  /** `unlock` prompt (at-rest, c72ec5df): obtain the master secret BEFORE restore
   *  so the encrypted SDK store can be opened — passkey path. */
  unlockSessionWithPasskey: () => Promise<void>
  /** `unlock` prompt: manual recovery-key path — derive the at-rest keys, decrypt
   *  the v2 session, open the encrypted store, restore, then unlock secret storage. */
  submitUnlockKey: (key: string) => Promise<void>
  /** Account view (d00dda45): re-derive and reveal the account's master unlock
   *  key (the passkey's PRF secret) so it can be used to sign in on another
   *  device or with the CLI. Requires a fresh passkey gesture — the tap IS the
   *  re-auth, and nothing is retained between reveals. Passkey-custody accounts
   *  only; the value is exactly what `recoverWithKey` / the CLI accept. */
  revealRecoveryKey: () => Promise<string>
  /** Account view (d00dda45): rotate Secure Backup to a fresh random recovery
   *  key and return it. DESTRUCTIVE — the previous recovery key (and any
   *  passkey) stops working. For a signed-in recovery-key account that lost or
   *  wants to rotate its key. */
  regenerateRecoveryKey: () => Promise<string>
  /** Account view (row_1782751521723): open the Stripe billing portal to manage
   *  or CANCEL the subscription. Mints a Matrix OpenID token (account-level, so
   *  it works while E2E is locked — e.g. at the verify gate) and exchanges it
   *  for a portal URL. Needs a live Matrix client. */
  openBillingPortal: () => Promise<void>
  /** Start Stripe Checkout via an authenticated POST (no name in the URL). */
  openCheckout: () => Promise<void>

  /** An in-progress (incoming) device verification, or null. Drives the verify
   *  screen's incoming-request prompt and emoji-compare step. */
  verification: VerificationState | null
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
    // Soft cutover (at-rest, c72ec5df): v1 (plaintext) entries still restore
    // as-is and upgrade to v2 (encrypted) on their next re-login; only NEW
    // accounts are encrypted at rest. (Hard-deleting v1 here would force a
    // re-login but breaks the legacy-restore tests — deferred.)
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

/** The store name off a LIVE session, for accounts signed in before the name
 *  was recorded on the entry. Those entries have no `storeName`, and their blob
 *  is encrypted at rest — but the session in memory is decrypted, so a sign-out
 *  can still find it. Without this, every account that existed before this
 *  change would orphan its store exactly once more. */
function storeNameFromRef(ref: { current: any }): string | undefined {
  try {
    return JSON.parse(ref.current?.sessionData?.() ?? '{}').storeName
  } catch {
    return undefined
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
  // At-rest encryption (c72ec5df): keys derived from the master secret at unlock,
  // held in memory for the session (to re-encrypt the session blob + snapshot).
  // `pendingUnlock` is the v2 account whose encrypted store awaits its unlock
  // gesture before we can restore it.
  const atRestKeysRef = useRef<AtRestKeys | null>(null)
  const pendingUnlockRef = useRef<AccountSession | null>(null)
  // Which unlock method this account uses — set explicitly by the recovery path
  // (passkey enroll/unlock vs recovery-key), so the persisted v2 `custody` (which
  // drives the unlock-gate UI) doesn't depend on the timing of passkeyEnrolledRef.
  const custodyRef = useRef<'passkey' | 'manual'>('manual')
  // Credentials held in memory through sign-in/up so we can re-key the device to
  // an ENCRYPTED store once the master secret exists (register bootstrap / unlock).
  const pendingRekeyRef = useRef<{ homeserver: string; user: string; password: string } | null>(null)
  // The account data key for this session (issue 8509dc68). Minted at
  // registration so the SDK store is encrypted from the first login; persisted
  // only as the two wraps above, never in the clear.
  const dataKeyRef = useRef<string | null>(null)
  // Forward reference to rekeyToEncryptedStore (defined later) so the recovery
  // callbacks above it can call it without a TDZ / dependency cycle.
  const rekeyRef = useRef<((secret: string) => Promise<void>) | null>(null)
  // Same reason: bootstrapWithKey needs to seal the data key the instant the
  // recovery key exists, and sealDataKey is defined below it.
  const sealDataKeyRef = useRef<((secret: string) => Promise<void>) | null>(null)
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
  // Whether a real platform authenticator is available — gates the passkey
  // flows. Detected once on mount (async); the ref lets the sign-in-time
  // bootstrap read the latest value without re-rendering deps. Headless browsers
  // with no authenticator report false here, so they keep the recovery-key flow.
  const [passkeyAvailable, setPasskeyAvailable] = useState(false)
  const passkeyAvailableRef = useRef(false)
  // Whether the account has a passkey enrolled (secure backup is passphrase-
  // keyed). Determined from account data when the verify gate is reached, so a
  // brand-new device can decide whether to offer passkey unlock before it can
  // decrypt anything. See `recoveryUsesPassphrase` in the WASM bridge.
  const [passkeyEnrolled, setPasskeyEnrolled] = useState(false)
  // Mirrors `passkeyEnrolled` for callbacks (submitRecoveryKey) that need the
  // latest value without being re-created when it changes.
  const passkeyEnrolledRef = useRef(false)
  useEffect(() => {
    hasPlatformAuthenticator().then(ok => {
      passkeyAvailableRef.current = ok
      setPasskeyAvailable(ok)
    })
  }, [])
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
  const restoreSession = useCallback(async (account: AccountSession, storePassphrase?: string) => {
    console.log('[auth] Restoring Matrix session for', account.userId)

    // The session blob is plaintext for v1 accounts and the just-decrypted blob
    // for v2 (the caller decrypts it at unlock and stashes it on matrixSessionData).
    if (!account.matrixSessionData) throw new Error('restoreSession: missing session blob')

    // Race MatrixSession.restore() against a timeout.  The Rust side builds
    // a Client (connects to homeserver) and calls restore_session — both are
    // async and can hang if the homeserver is unreachable or slow.
    // storePassphrase (v2) opens the at-rest-ENCRYPTED IndexedDB store; undefined
    // = plaintext store (v1 / legacy).
    const RESTORE_TIMEOUT_MS = 10_000
    // A restore knows which account it is restoring, so the worker can hand back
    // a client a sibling tab already built instead of making a second one.
    const restorePromise = buildSession(
      'restore',
      [account.homeserverUrl, account.matrixSessionData, storePassphrase],
      account.userId,
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
  const bootstrapWithKey = useCallback(async (ms: any) => {
    const retryDelaysMs = [0, 2000, 5000]
    let lastErr: unknown
    for (const delay of retryDelaysMs) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
      try {
        const recoveryKey: string = await ms.enableRecovery()
        // Seal NOW, not when the user ticks the box.
        //
        // The SDK store has been encrypted since login, with a data key that
        // until this moment exists only in memory (`dataKeyRef`). Sealing was
        // deferred to `confirmKeySaved`, so anyone who closed the tab on the
        // "save your key" screen left no on-disk way back to that data key —
        // and the next load could not open its own store. Server-side the
        // backup was already Enabled, so bootstrap never ran again and the key
        // was never re-shown. That is a hard lockout, reached by closing a tab.
        //
        // Sealing here discloses nothing: it writes the same two wraps a
        // confirmation would have, using a key we are about to display anyway.
        // The user's confirmation is about whether THEY have saved it; it was
        // never the right gate for whether the BROWSER can reopen its store.
        await sealDataKeyRef.current?.(recoveryKey)
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

  // On a passkey-capable browser, let the user choose passkey vs recovery key
  // BEFORE secure backup is enabled (so the choice never re-keys it). Without
  // passkeys, go straight to the classic recovery-key bootstrap.
  /**
   * EVERY first device bootstraps a random recovery key and is shown it. There
   * is no longer a passkey-vs-key fork here: a passkey is offered afterwards, as
   * a speed-up that wraps this key rather than replacing it (issue 63dc1339).
   */
  const bootstrapRecovery = useCallback(
    async (ms: any) => {
      await bootstrapWithKey(ms)
    },
    [bootstrapWithKey],
  )

  /**
   * The user has confirmed they saved their recovery key. Offer the passkey as
   * a SPEED-UP, carrying the key so it can be wrapped (issue 63dc1339).
   *
   * The order is the point. Previously a passkey-capable browser was asked to
   * CHOOSE between a passkey and a recovery key, and choosing the passkey keyed
   * secret storage with the PRF secret — so the passkey was the primary custody
   * and a PRF-less provider was a mid-flow dead end. Now everyone leaves setup
   * with a saved key that always works, and the passkey is strictly additive.
   */
  const offerPasskeySpeedup = useCallback(
    (recoveryKey: string) => {
      if (passkeyAvailableRef.current) {
        setRecoveryPrompt({ kind: 'speedup', recoveryKey })
      } else {
        setRecoveryPrompt(null)
      }
    },
    [],
  )

  /** Persist the wrap record locally on the active account. Also re-persists the
   *  session blob so the entry is written as v2 with the current custody. */
  const persistPasskeyWrap = useCallback((json: string) => {
    const uid: string | undefined = matrixSessionRef.current?.userId?.()
    if (!uid) return
    setAccounts(prev => {
      const updated = prev.map(a =>
        a.userId === uid ? { ...a, passkeyWrap: json, custody: 'passkey' as const } : a,
      )
      saveAccounts(updated)
      return updated
    })
  }, [])

  /**
   * `speedup` prompt: enrol a passkey that unlocks WITHOUT replacing the key.
   *
   * Wraps the recovery key under the passkey's PRF output and stores that in
   * account data. Secret storage is not touched at all, which is what makes a
   * PRF-less provider harmless here: nothing about the account has changed, so
   * "no harm done" is a fact rather than a reassurance.
   */
  const addPasskeySpeedup = useCallback(async (recoveryKey: string) => {
    const ms = matrixSessionRef.current
    if (!ms) throw new Error('Not signed in')
    const uid = (typeof ms.userId === 'function' ? ms.userId() : null) ?? 'tidework'
    const { secret, credentialId } = await registerPasskeyPrf(uid, uid)
    const record = await addPasskeyWrap(await loadWrapRecord(ms), {
      credentialId,
      prfSecret: secret,
      recoveryKey,
    })
    await saveWrapRecord(ms, record)
    // Custody is now 'passkey': the unlock gate should LEAD with the passkey for
    // this account. It still offers the typed key — that is the whole point —
    // this only picks the default. Set BEFORE the re-key below, so the v2 entry
    // that re-key writes records the right custody.
    custodyRef.current = 'passkey'
    passkeyEnrolledRef.current = true
    setPasskeyEnrolled(true)
    // Re-key this device to an ENCRYPTED store (at-rest, c72ec5df), exactly
    // where the old passkey path did it. Deliberately NOT on the key-only path:
    // that never re-keyed either, and putting a fresh login on every first
    // device's critical path is both slow and a behaviour change this stage did
    // not set out to make. Widening at-rest to key-only accounts is its own
    // piece of work. No-op when credentials aren't held (e.g. OAuth).
    await rekeyRef.current?.(recoveryKey)
    // Store the wrap locally LAST. The re-key rebuilds the account entry, so
    // writing it earlier only survives because that rebuild now merges it
    // forward — doing it after removes the dependence on that ordering
    // altogether. This local copy is what makes cold-start unlock possible; see
    // `passkeyWrap` on AccountSession for why it is unavoidable.
    persistPasskeyWrap(JSON.stringify(record))
  }, [persistPasskeyWrap])

  /**
   * Persist both ways back to this session's data key (issue 8509dc68):
   * `deviceKeyWrap` under this browser's non-extractable device key, and
   * `dataKeyWrap` under the master secret.
   *
   * Both matter, for different failures. Without the DEVICE wrap every page load
   * would prompt for the master secret, which is what made at-rest unusable.
   * Without the MASTER wrap, losing this browser profile would be unrecoverable —
   * the device key cannot be backed up by design.
   *
   * Idempotent and safe whenever a master secret becomes known: at setup, after a
   * typed-key unlock, or after a rotation. With no data key in memory (a legacy
   * account on the old scheme) it does nothing, so callers never have to know
   * which scheme an account uses.
   */
  const sealDataKey = useCallback(async (masterSecret: string) => {
    const dataKey = dataKeyRef.current
    if (!dataKey || !masterSecret) return
    try {
      const deviceKey = await getOrCreateDeviceKey()
      const [dataKeyWrap, deviceKeyWrap, keys] = await Promise.all([
        wrapDataKey(masterSecret, dataKey),
        encryptString(deviceKey, dataKey),
        deriveAtRestKeysFromDataKey(dataKey),
      ])
      atRestKeysRef.current = keys
      setSnapshotKey(keys.snapshotKey)
      const uid: string | undefined = matrixSessionRef.current?.userId?.()
      if (!uid) return
      // Re-encrypt the session blob under the data-key token key in the same pass.
      // Writing the wraps without it would leave a v2 entry whose `secrets` were
      // sealed under a different key — openable by nothing.
      const blob: string | undefined = matrixSessionRef.current?.sessionData?.()
      const secrets = blob ? await encryptString(keys.tokenKey, blob) : undefined
      setAccounts(prev => {
        const updated = prev.map(a =>
          a.userId === uid
            ? {
                ...a,
                v: 2 as const,
                custody: custodyRef.current,
                dataKeyWrap,
                deviceKeyWrap,
                ...(secrets ? { secrets, matrixSessionData: undefined } : {}),
              }
            : a,
        )
        saveAccounts(updated)
        return updated
      })
    } catch (e) {
      // Best-effort: a failure leaves the account v1 (plaintext at rest) rather
      // than unopenable. Loud, because it is otherwise a silent downgrade.
      // The account stays v1, which — since the store itself is encrypted from
      // login — means this browser cannot reopen it. Loud, because it is the
      // difference between "degraded" and "locked out".
      console.error('[auth] could not seal the data key; this browser may not reopen the store:', e)
    }
  }, [])
  sealDataKeyRef.current = sealDataKey

  /** Record that this account's key has been saved, so neither the legacy
   *  migration nor the save step nags again. Defined before its consumers: a
   *  `useCallback` named in a dependency array is evaluated at render, so a
   *  later definition is a TDZ crash rather than a hoisted reference. */
  const markKeySaved = useCallback(() => {
    const uid: string | undefined = matrixSessionRef.current?.userId?.()
    if (!uid) return
    setAccounts(prev => {
      const updated = prev.map(a => (a.userId === uid ? { ...a, keySaved: true } : a))
      saveAccounts(updated)
      return updated
    })
  }, [])

  /** `save` prompt: the user says they stored the key. Hand off to the optional
   *  passkey step. */
  const confirmKeySaved = useCallback(
    async (recoveryKey: string) => {
      markKeySaved()
      // Seal the data key now that a master secret exists. This REPLACES the old
      // rekeyToEncryptedStore re-login: the store is already encrypted (opened
      // with a data-key-derived passphrase at login), so all that is missing is a
      // record of how to get the data key back. (issue 8509dc68)
      await sealDataKey(recoveryKey)
      offerPasskeySpeedup(recoveryKey)
    },
    [offerPasskeySpeedup, markKeySaved, sealDataKey],
  )

  /**
   * `save-legacy-key`: reveal the master secret of an account enrolled under the
   * OLD passkey-first custody, where secret storage was keyed WITH the PRF
   * output. Those users have a working master key they have never seen, and can
   * only obtain via their passkey — so losing the passkey loses the account.
   *
   * Revealing it is the whole migration. Nothing is rotated: the PRF secret
   * already IS the master key, so writing it down makes the account match the
   * new model (a manual key that always works, plus a passkey that unlocks)
   * without touching secret storage or invalidating the at-rest store — which a
   * rotation would, since the local caches are keyed by the old secret.
   */
  const revealLegacyKey = useCallback(async (): Promise<string> => {
    return await unlockPasskeyPrf()
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
        } else if (status === 'ready') {
          // A ready account under the OLD passkey-first custody: secret storage
          // is keyed with the PRF output, so a working master key exists that
          // the user has never seen and can only get from the passkey. Losing
          // the passkey therefore loses the account. Prompt once to save it —
          // see `revealLegacyKey` for why this needs no rotation. (63dc1339)
          const uid: string | undefined = ms.userId?.()
          const account = uid ? loadAccounts().find(a => a.userId === uid) : undefined
          if (account?.custody === 'passkey' && !account.keySaved) {
            setRecoveryPrompt({ kind: 'save-legacy-key' })
          }
        } else if (status === 'needs_recovery') {
          // Offer passkey unlock only if the account actually has a passkey —
          // i.e. secure backup is passphrase-keyed (our PRF). Legacy accounts
          // (raw recovery key) would only see a dead-end button, so detect this
          // before showing the gate. Guard for older bindings / mocks.
          // Does this account have a passkey? Under the new model that question
          // is answered by the WRAP RECORD, not by whether secret storage is
          // passphrase-keyed: a wrapped account's 4S key is random, so the old
          // probe now says "no passkey" for every account that has one, and the
          // unlock option would never appear. The probe is still consulted as a
          // fallback, because a legacy account genuinely IS passphrase-keyed and
          // has no wrap. (issue 63dc1339)
          try {
            let enrolled = hasEnrolledPasskey(await loadWrapRecord(ms))
            if (!enrolled && typeof ms.recoveryUsesPassphrase === 'function') {
              enrolled = await ms.recoveryUsesPassphrase()
            }
            passkeyEnrolledRef.current = enrolled
            setPasskeyEnrolled(enrolled)
          } catch (e) {
            console.warn('[auth] passkey-enrollment check failed:', e)
            passkeyEnrolledRef.current = false
            setPasskeyEnrolled(false)
          }
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
    const t0 = performance.now()
    await ms.recoverWithKey(key)
    console.log(`[auth] recoverWithKey took ${Math.round(performance.now() - t0)}ms`)
    // Re-sync so room keys from backup land and history decrypts — but bounded:
    // on a large account this sync covers EVERY joined room and used to hold the
    // verify gate hostage (issue 58dfe52b). Past the bound it finishes in the
    // background and the next sync picks up whatever's left.
    await syncBounded(ms, POST_RECOVERY_SYNC_TIMEOUT_MS, 'post-recovery sync')
    // A legacy account (no passkey enrolled) that just unlocked with its master
    // key on a passkey-capable device: offer to protect it with a passkey so
    // future devices need no typed key. Declining proceeds into the app. The
    // passkey-unlock path never reaches here as a legacy account (it's gated on
    // enrollment), so this only fires after a master-key restore.
    // New-device sign-in: the store is ALREADY encrypted, so all that is missing
    // is a record of how to recover its data key — without this the device could
    // never open its own store again. (issue 8509dc68)
    await sealDataKey(key)
    if (passkeyAvailableRef.current && !passkeyEnrolledRef.current) {
      // Additive, not a rotation: wrap the key they just typed.
      setRecoveryPrompt({ kind: 'speedup', recoveryKey: key })
    } else {
      setRecoveryPrompt(null)
    }
  }, [sealDataKey])

  /** `verify` prompt: unlock with the account's passkey — derive its PRF secret
   *  and feed it to the same recover path (`recoverWithKey` accepts a
   *  passphrase). Throws on cancel / bad key so the screen surfaces it. */
  const unlockWithPasskey = useCallback(async () => {
    const secret = await unlockPasskeyPrf()
    const ms = matrixSessionRef.current
    // New model: the passkey WRAPS the recovery key, so the PRF output opens the
    // wrap and the key inside is what secret storage actually wants.
    //
    // Falling back to the raw secret is not defensive padding — it is the whole
    // migration path for accounts enrolled under the OLD custody, where secret
    // storage was keyed WITH the PRF output. Those accounts have no wrap, and
    // for them the PRF secret IS the master key. Both work here, so no account
    // has to be rotated to move between models. (issue 63dc1339)
    const unwrapped = ms ? await unwrapRecoveryKey(await loadWrapRecord(ms), secret) : null
    await submitRecoveryKey(unwrapped ?? secret)
  }, [submitRecoveryKey])

  /** Unlock-first cold start (c72ec5df): the master `secret` (passkey-PRF or a
   *  typed recovery key) derives the at-rest keys, decrypts the v2 session blob,
   *  opens the ENCRYPTED SDK store, restores, then unlocks secret storage with
   *  the same secret. A wrong secret fails at AES-GCM decryption (before we
   *  touch the SDK), so the gate can surface an error and re-prompt. */
  /**
   * Restore an at-rest account using THIS BROWSER'S device key — the no-prompt
   * path (issue 8509dc68). Resolves true when it worked.
   *
   * No `recoverWithKey` here, and that is the point rather than an omission: the
   * SDK store we are opening already holds this device's cross-signing and room
   * keys from when it was last used. Secret storage only needs to be re-opened on
   * a device that has never had them. So the master secret is not required to read
   * your own screen — only to get a NEW device in.
   *
   * Returns false rather than throwing on any failure, so the caller falls back to
   * the unlock prompt. A device key that cannot open this wrap is an ordinary
   * situation — a cleared profile, a different browser, a re-keyed account — and
   * must not become an error the user has to interpret.
   */
  const restoreWithDeviceKey = useCallback(
    async (account: AccountSession): Promise<boolean> => {
      if (!account.deviceKeyWrap || !account.secrets) return false
      try {
        const deviceKey = await getDeviceKey()
        if (!deviceKey) return false
        const dataKey = await decryptString(deviceKey, account.deviceKeyWrap)
        const keys = await deriveAtRestKeysFromDataKey(dataKey)
        const blob = await decryptString(keys.tokenKey, account.secrets)

        dataKeyRef.current = dataKey
        atRestKeysRef.current = keys
        setSnapshotKey(keys.snapshotKey)

        const ms = await restoreSession(
          { ...account, matrixSessionData: blob },
          keys.storePassphrase,
        )
        matrixSessionRef.current = ms
        setMatrixSession(ms)
        setLoading(false)
        console.log('[auth] restored from this device’s key — no unlock needed')

        try {
          const entries = parseWorkspaceRooms(await ms.listRooms())
          if (entries.length > 0) {
            setWorkspaces(entries)
            saveWorkspaces(account.userId, entries)
          }
        } catch (e) {
          console.warn('[auth] listRooms after device-key restore failed:', e)
        }
        return true
      } catch (e) {
        console.warn('[auth] device-key restore failed; falling back to unlock:', e)
        return false
      }
    },
    [restoreSession],
  )

  const unlockAndRestore = useCallback(async (secret: string) => {
    const account = pendingUnlockRef.current
    if (!account?.secrets) throw new Error('No encrypted session awaiting unlock')
    // Which at-rest scheme? A `dataKeyWrap` means the envelope: the secret opens
    // the wrap and the DATA key inside is what everything at rest is keyed by.
    // Without one it is a legacy account whose store passphrase came straight
    // from the master secret — still supported, since migrating it would need
    // the very re-login the envelope exists to avoid. (issue 8509dc68)
    let keys: AtRestKeys
    if (account.dataKeyWrap) {
      const dataKey = await unwrapDataKey(secret, account.dataKeyWrap) // throws on a wrong secret
      dataKeyRef.current = dataKey
      keys = await deriveAtRestKeysFromDataKey(dataKey)
    } else {
      keys = await deriveAtRestKeys(secret)
    }
    const blob = await decryptString(keys.tokenKey, account.secrets) // throws on wrong secret
    atRestKeysRef.current = keys
    setSnapshotKey(keys.snapshotKey) // publish for useWorkspace snapshot encryption
    const ms = await restoreSession({ ...account, matrixSessionData: blob }, keys.storePassphrase)
    matrixSessionRef.current = ms
    setMatrixSession(ms)
    // Unlock secret storage with the same secret so encrypted history decrypts.
    const t0 = performance.now()
    await ms.recoverWithKey(secret)
    console.log(`[auth] recoverWithKey took ${Math.round(performance.now() - t0)}ms`)
    // Bounded for the same reason as submitRecoveryKey (issue 58dfe52b): the
    // full-account sync must not keep the unlock gate up.
    const { done: syncDone } = await syncBounded(ms, POST_RECOVERY_SYNC_TIMEOUT_MS, 'post-unlock sync')
    pendingUnlockRef.current = null
    setRecoveryPrompt(null)
    setLoading(false)
    const refreshWorkspaces = async () => {
      try {
        const entries = parseWorkspaceRooms(await ms.listRooms())
        if (entries.length > 0) {
          setWorkspaces(entries)
          saveWorkspaces(account.userId, entries)
        }
      } catch (e) {
        console.warn('[auth] listRooms after unlock failed:', e)
      }
    }
    // Immediate pass may be partial if the sync raced out; refresh again once
    // the background sync truly lands.
    await refreshWorkspaces()
    void syncDone.then(refreshWorkspaces)
  }, [restoreSession])

  /** 'unlock' gate, passkey path: derive the PRF secret, then unlock + restore. */
  const unlockSessionWithPasskey = useCallback(async () => {
    custodyRef.current = 'passkey'
    const secret = await unlockPasskeyPrf()
    // Unwrap from the LOCAL copy of the wrap record. This is the whole reason a
    // local copy exists: the master secret is needed to open the encrypted store,
    // the account-data copy needs a client, and a client needs that store. There
    // is no client here at all.
    //
    // No wrap means a legacy account whose 4S key IS the PRF secret, so the raw
    // secret is the master secret — the same fallback the verify gate uses, which
    // keeps both custody models on one code path.
    const record = parseWrapRecord(pendingUnlockRef.current?.passkeyWrap)
    const unwrapped = await unwrapRecoveryKey(record, secret)
    await unlockAndRestore(unwrapped ?? secret)
    // Unlocking via passkey proves the account has one — mark it enrolled so the
    // account view can offer "reveal recovery key" (the cold-start unlock path
    // doesn't run ensureHistoryAccess, which is the other place this is set).
    passkeyEnrolledRef.current = true
    setPasskeyEnrolled(true)
  }, [unlockAndRestore])

  /** Account view: re-derive and reveal the master unlock key via a fresh passkey
   *  gesture (the re-auth). Nothing is retained between reveals — `unlockPasskeyPrf`
   *  re-runs the assertion each time. The returned PRF secret is the same secret
   *  `recoverWithKey` / the CLI's `recover_with_key` / the verify gate accept, so
   *  it ports the account to another device or the CLI. (issue d00dda45) */
  const revealRecoveryKey = useCallback(async (): Promise<string> => {
    return await unlockPasskeyPrf()
  }, [])

  /** Account view: rotate Secure Backup to a fresh random recovery key (the
   *  SDK's `reset_key` with no passphrase) and return it. Destructive — the old
   *  recovery key / passkey stops working, and the new key is the only way in.
   *  The current session keeps running; a v2 (at-rest) account's local cache is
   *  keyed by the OLD secret, so its next cold start needs a fresh sign-in with
   *  the new key (recoverable via the gate's sign-out). (issue d00dda45) */
  const regenerateRecoveryKey = useCallback(async (): Promise<string> => {
    const ms = matrixSessionRef.current
    if (!ms) throw new Error('Not signed in')
    return await ms.resetRecovery()
  }, [])

  /** Account view: open the Stripe billing portal to manage / cancel the
   *  subscription (issue row_1782751521723). Mint a Matrix OpenID token (works
   *  while E2E is locked — it's account-level), exchange it at the billing
   *  Worker for a portal URL, and navigate there. The at-rest unlock gate has no
   *  client (the token is encrypted at rest), so this needs a built session —
   *  the verify gate / signed-in app have one. */
  const openBillingPortal = useCallback(async () => {
    const ms = matrixSessionRef.current
    if (!ms || typeof ms.requestOpenIdToken !== 'function') {
      throw new Error('Please sign in again to manage your subscription.')
    }
    const url = await fetchPortalUrl(await ms.requestOpenIdToken())
    window.location.assign(url)
  }, [])

  /** Start Stripe Checkout. Same OpenID proof as the portal, for the same
   *  reason plus one more: the old link carried ?username= through a top-level
   *  navigation, so the account name reached history, referrers and
   *  screenshots. Here the Worker derives it from the verified token. */
  const openCheckout = useCallback(async () => {
    const ms = matrixSessionRef.current
    if (!ms || typeof ms.requestOpenIdToken !== 'function') {
      throw new Error('Please sign in again to subscribe.')
    }
    const url = await fetchCheckoutUrl(await ms.requestOpenIdToken())
    window.location.assign(url)
  }, [])


  // NOTE: the old `migrateToPasskey` lived here. It called
  // `resetRecoveryWithPassphrase`, which ROTATED secret storage onto the PRF
  // secret and killed the user's existing master key — the very thing this
  // redesign forbids. It needed a confirm-before-rotate guard (issue 05a98123)
  // precisely because it was destructive. With the wrap there is nothing to
  // rotate and nothing to guard: adding a passkey to an account that unlocked
  // with its typed key is the SAME additive operation as adding one at setup,
  // so it reuses `addPasskeySpeedup` via the `speedup` prompt.

  const dismissRecoveryPrompt = useCallback(() => {
    setRecoveryPrompt(null)
  }, [])

  // ── Device verification driver (incoming only) ──────────────────────────────
  //
  // Drives an INCOMING DeviceVerification handle (another of the user's devices
  // asked to verify this one) to completion by repeatedly advancing it and
  // mirroring its state into React. It relies on the sync already running in the
  // app. On `done`, the device is trusted and gets its keys, so we clear the gate
  // and re-sync. The self-initiated SAS flow was removed (issue 73d01ae2); the
  // between-device replacement is reveal/regenerate recovery key. (ADR 0001 D-3.)
  const runVerificationLoop = useCallback((handle: any) => {
    verificationStopRef.current?.()
    let stopped = false
    verificationStopRef.current = () => {
      stopped = true
    }

    const tick = async () => {
      if (stopped) return
      try {
        const status: string = await handle.advance()
        let emoji: SasEmoji[] = []
        try {
          // Awaited: sync on the in-tab bridge, a port round-trip when the
          // client lives in the SharedWorker. `await` covers both.
          emoji = JSON.parse((await handle.emoji()) || '[]')
        } catch {
          /* emoji not ready */
        }
        setVerification({ role: 'incoming', status: status as VerificationState['status'], emoji })

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

  const acceptIncomingVerification = useCallback(async () => {
    const handle = verificationRef.current
    if (!handle) return
    await handle.accept()
    runVerificationLoop(handle)
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

  // Overwrite a single account's persisted session blob (e.g. after the SDK
  // refreshes OAuth tokens). Functional update so it never goes stale against
  // the account pool.
  const persistSessionBlob = useCallback((userId: string, blob: string) => {
    if (!blob) return
    const write = (patch: Partial<AccountSession>) =>
      setAccounts(prev => {
        const updated = prev.map(a => (a.userId === userId ? { ...a, ...patch } : a))
        saveAccounts(updated)
        return updated
      })
    const keys = atRestKeysRef.current
    if (keys) {
      // v2 (at-rest): encrypt the session blob; drop any plaintext copy. Fired on
      // every token refresh, so the persisted token is always ciphertext.
      encryptString(keys.tokenKey, blob)
        .then(secrets =>
          write({
            v: 2,
            custody: custodyRef.current,
            secrets,
            matrixSessionData: undefined,
          }),
        )
        .catch(e => console.warn('[auth] session-blob encrypt failed:', e))
    } else {
      write({ matrixSessionData: blob }) // v1 (pre-unlock / legacy)
    }
  }, [])

  // Keep the stored session blob current with the SDK's live tokens. MAS access
  // tokens are short-lived; the SDK refreshes them in-memory, but a reload would
  // restore the *dead* token captured at sign-in unless we re-persist. We re-save
  // once now (restore/sign-in may have already refreshed during the first
  // round-trip) and on every subsequent refresh.
  useEffect(() => {
    const ms = matrixSession
    if (!ms || typeof ms.startTokenPersistence !== 'function') return
    const uid: string | undefined = ms.userId?.()
    if (!uid) return
    try {
      persistSessionBlob(uid, ms.sessionData())
    } catch {
      /* no active session yet — the refresh callback will catch up */
    }
    ms.startTokenPersistence((blob: string) => persistSessionBlob(uid, blob))
  }, [matrixSession, persistSessionBlob])

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
        // Awaited for the same reason as `handle.emoji()` above.
        const flow: string | undefined = await ms.pendingVerificationFlow?.()
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
    // v2 (at-rest): the encrypted SDK store cannot be opened without the data
    // key. There are two ways to get it, and the ORDER is the entire UX of this
    // feature (issue 8509dc68).
    if (account?.v === 2 && account.secrets) {
      // Async because step 1 reads IndexedDB. Self-invoking rather than making
      // the whole effect async, so the non-v2 path below stays synchronous.
      void (async () => {
        // 1. THIS BROWSER'S DEVICE KEY — no prompt at all. A non-extractable
        //    CryptoKey in IndexedDB, so the key material is not in the value on
        //    disk and script can never export it (proved in
        //    e2e/device-key.spec.ts). Encryption at rest should not cost a
        //    recovery key on every refresh.
        if (account.deviceKeyWrap && (await restoreWithDeviceKey(account))) return
        // 2. Otherwise ask. A new device, or this one after its device key was
        //    cleared by sign-out — the master secret is what gets in from cold.
        console.log('[auth] Encrypted session — prompting to unlock before restore')
        pendingUnlockRef.current = account
        setRecoveryPrompt({ kind: 'unlock', custody: account.custody })
        setLoading(false)
      })()
      return
    }

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
        // Only a DEFINITIVE rejection removes the account. This used to keep
        // the account solely when the message said "timed out" and delete it
        // for everything else — so a few minutes of the auth service being
        // unreachable signed the user out and cleared their cached workspaces
        // (observed in prod 2026-07-26). An unreachable server says nothing
        // about whether the session is still valid, so it must fail open.
        if (!isSessionRejected(err)) {
          console.warn('[auth] Restore failed without a rejection, keeping account:', err)
          setError('Could not reach the homeserver. Check your connection and reload.')
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

      // Persist full session data including tokens. When at-rest keys are set
      // (the re-keyed device), write a v2 entry with the token blob encrypted.
      const matrixSessionData: string = ms.sessionData()
      // Lift the store name OUT of the blob and onto the entry, in plaintext.
      // This is the only moment it is legible for a v2 account: from here the
      // blob is encrypted, so a signed-out account's store could never be
      // named again — and therefore never deleted. (issue f6901da6)
      let storeName: string | undefined
      try {
        storeName = JSON.parse(matrixSessionData)?.storeName
      } catch {
        /* an unparseable blob is the session's problem, not the reaper's */
      }
      const keys = atRestKeysRef.current
      const account: AccountSession = keys
        ? {
            homeserverUrl: homeserver,
            userId: uid,
            username: usernameHint,
            v: 2,
            custody: custodyRef.current,
            storeName,
            secrets: await encryptString(keys.tokenKey, matrixSessionData),
          }
        : {
            homeserverUrl: homeserver,
            userId: uid,
            username: usernameHint,
            storeName,
            matrixSessionData,
          }

      // Add or update in the account pool
      setAccounts(prev => {
        // CARRY FORWARD the per-account facts that aren't derivable from a fresh
        // sign-in: whether the user has saved their key, and the local passkey
        // wrap. This function rebuilds the entry from scratch, and it runs again
        // during the at-rest re-key — so without this, enrolling a passkey wiped
        // `keySaved` and re-raised the "save your key" prompt over the success
        // screen, and dropped the very wrap just written. (issue 63dc1339)
        const previous = prev.find(a => a.userId === uid)
        const merged: AccountSession = {
          ...account,
          keySaved: account.keySaved ?? previous?.keySaved,
          passkeyWrap: account.passkeyWrap ?? previous?.passkeyWrap,
          storeName: account.storeName ?? previous?.storeName,
        }
        // The at-rest re-key logs in AGAIN as a fresh device, so this entry now
        // points at a new store and the old one is dead the moment we overwrite
        // it. rekeyToEncryptedStore deletes that store directly; this catches
        // any other path that replaces a store name.
        if (previous?.storeName && merged.storeName && previous.storeName !== merged.storeName) {
          void retireStore(previous.storeName)
        }
        const updated = prev.filter(a => a.userId !== uid)
        updated.push(merged)
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

  /** Re-key a freshly signed-in/registered device (whose store is still
   *  plaintext) to an ENCRYPTED store, once the master `secret` exists. Logs in
   *  again as a fresh device WITH the store passphrase, re-downloads room keys
   *  from the server backup (recoverWithKey), persists a v2 entry, then drops the
   *  transient plaintext store. No-op without held credentials (e.g. OAuth — TODO
   *  OAuth re-key has no password). */
  const rekeyToEncryptedStore = useCallback(
    async (secret: string) => {
      const creds = pendingRekeyRef.current
      if (!creds) return
      const keys = await deriveAtRestKeys(secret)
      atRestKeysRef.current = keys
      setSnapshotKey(keys.snapshotKey) // publish for useWorkspace snapshot encryption
      let oldStoreName: string | undefined
      try {
        oldStoreName = JSON.parse(matrixSessionRef.current?.sessionData?.() ?? '{}').storeName
      } catch {
        /* ignore */
      }
      const ms = await buildSession('login', [
        creds.homeserver,
        creds.user,
        creds.password,
        keys.storePassphrase,
      ])
      await ms.initialSync()
      await ms.recoverWithKey(secret) // re-download room keys into the encrypted store
      // Bounded (issue 58dfe52b): this runs inside the gate's spinner via
      // submitRecoveryKey → rekey; stragglers download in the background.
      await syncBounded(ms, POST_RECOVERY_SYNC_TIMEOUT_MS, 'post-rekey sync')
      await completeSignIn(ms, creds.homeserver, creds.user) // writes a v2 entry
      pendingRekeyRef.current = null
      if (oldStoreName) {
        try {
          indexedDB.deleteDatabase(oldStoreName)
        } catch {
          /* best-effort cleanup of the transient plaintext store */
        }
      }
    },
    [completeSignIn],
  )
  rekeyRef.current = rekeyToEncryptedStore

  // ── signIn: add or update an account in the pool ───────────────────────────
  const signIn = useCallback(
    async (homeserver: string, user: string, password: string) => {
      setLoading(true)
      setError(null)

      try {
        // As in signUp: encrypted store from the first login (issue 8509dc68).
        const dataKey = generateDataKey()
        dataKeyRef.current = dataKey
        const ms = await buildSession('login', [
          homeserver,
          user,
          password,
          await deriveStorePassphraseFromDataKey(dataKey),
        ])
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
        // Dynamic client registration + authorization URL; the PKCE verifier
        // stays in the client that issued it, which is why the popup (not a
        // full-page redirect) carries the user through MAS — and why this has to
        // take the same route as finishOauthLogin below (see staticSessionCall).
        // BASE_URL keeps this correct under sub-path deployments (e.g. GH
        // Pages serves the app at /<repo>/) as well as root-path hosting.
        const authUrl: string = await staticSessionCall(
          'startOauthLogin',
          homeserver,
          `${window.location.origin}${import.meta.env.BASE_URL}oauth/callback`,
        )
        popup.navigate(authUrl)
        const redirectedUrl = await popup.waitForCallback()

        const ms = await buildSession('finishOauthLogin', [redirectedUrl])
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
      return await staticSessionCall('homeserverSupportsOauth', homeserver)
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
        // Encrypted store from the FIRST login (issue 8509dc68): the data key is
        // random and independent of any master secret, so it exists before a
        // recovery key does. This is what retires rekeyToEncryptedStore.
        const dataKey = generateDataKey()
        dataKeyRef.current = dataKey
        const ms = await buildSession('register', [
          homeserver,
          user,
          password,
          await deriveStorePassphraseFromDataKey(dataKey),
        ])
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
      const leaving = currentId ? prev.find(a => a.userId === currentId) : undefined
      const updated = currentId ? prev.filter(a => a.userId !== currentId) : []
      saveAccounts(updated)
      // The device's store for this account is now unreachable — the entry that
      // named it is gone. Queue it; the worker probably still has it open, so
      // the boot sweep is what usually finishes the job. (issue f6901da6)
      void retireStore(leaving?.storeName ?? storeNameFromRef(matrixSessionRef))

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
    // Reset at-rest session state so the next account doesn't inherit keys/custody.
    atRestKeysRef.current = null
    custodyRef.current = 'manual'
    dataKeyRef.current = null
    setSnapshotKey(null)
    // Forget this browser's device key. Leaving it would let whoever uses this
    // browser next open any ciphertext that survived sign-out. The master-secret
    // wrap is what makes the account recoverable afterwards. (issue 8509dc68)
    void clearDeviceKey()
    // Dismiss any blocking gate (verify / at-rest unlock / active verification) so
    // signing out from the device-security screen always returns to sign-in instead
    // of leaving the overlay stuck. The auto-restore effect is one-shot, so it won't
    // re-raise the prompt for the account we just removed. (issue 7495dd9a)
    pendingUnlockRef.current = null
    setRecoveryPrompt(null)
    setVerification(null)
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

      // v2 (at-rest): gate behind the unlock prompt like cold start.
      if (account.v === 2 && account.secrets) {
        pendingUnlockRef.current = account
        setRecoveryPrompt({ kind: 'unlock', custody: account.custody })
        setLoading(false)
        return
      }

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
        const removed = prev.find(a => a.userId === targetUserId)
        const updated = prev.filter(a => a.userId !== targetUserId)
        saveAccounts(updated)
        // The removed account may never have been the active one, in which case
        // its session blob is encrypted and unreadable — which is exactly why
        // the store name is kept in plaintext on the entry. (issue f6901da6)
        void retireStore(removed?.storeName)
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
  /**
   * Open a room for MEMBERSHIP work (roles, leaving) — not for its data.
   *
   * Both shapes expose the same four methods, so the caller doesn't branch. It
   * goes through `ConnectedWorkspace` because that is where the role and leave
   * rules live, already tested: `leaveWorkspace` refuses a sole-admin departure
   * and `setUserRole` refuses a last-admin self-demotion. Reimplementing either
   * at session level would mean a second copy of rules that must not disagree.
   *
   * The cost is a history gather per workspace, which is wasteful for an
   * operation that only touches membership state. Accepted deliberately: a reset
   * is rare, deliberate and irreversible, so reusing proven code beats saving
   * seconds.
   */
  const openRoomForMembership = useCallback(async (ms: any, roomId: string) => {
    if (ms?.isWorkerSession) {
      const worker = await connectWorker()
      await worker.openWorkspace(ms.userId(), roomId, getSnapshotKey() ?? undefined)
      return {
        listMembers: () => worker.roomCall(roomId, 'listMembers') as Promise<string>,
        myRole: () => worker.roomCall(roomId, 'myRole') as Promise<string>,
        setUserRole: (u: string, r: string) =>
          worker.roomCall(roomId, 'setUserRole', u, r) as Promise<void>,
        leaveWorkspace: (all: boolean) =>
          worker.roomCall(roomId, 'leaveWorkspace', all) as Promise<void>,
      }
    }
    const wasm = await getWasmModule()
    return await wasm.ConnectedWorkspace.create(ms, roomId, undefined)
  }, [])

  const listResettableWorkspaces = useCallback(async (): Promise<ResettableWorkspace[]> => {
    const ms = matrixSessionRef.current
    if (!ms) throw new Error('Not signed in')
    const rooms = parseWorkspaceRooms(await ms.listRooms())
    const me = ms.userId?.()
    const out: ResettableWorkspace[] = []
    for (const room of rooms) {
      try {
        const handle = await openRoomForMembership(ms, room.id)
        const members = JSON.parse(await handle.listMembers()) as Array<{
          userId: string
          displayName?: string
          role?: string
        }>
        const myRole = await handle.myRole()
        out.push({
          id: room.id,
          name: room.name,
          amAdmin: myRole === 'admin',
          others: members
            .filter(m => m.userId !== me)
            .map(m => ({ id: m.userId, label: m.displayName || m.userId, role: m.role ?? 'editor' })),
        })
      } catch (e) {
        // A workspace we cannot even inspect must not block the reset — report it
        // as "nobody else here", which offers delete, and let the attempt fail
        // loudly later if it really can't be left.
        console.warn(`[reset] could not inspect ${room.id}:`, e)
        out.push({ id: room.id, name: room.name, amAdmin: false, others: [] })
      }
    }
    return out
  }, [openRoomForMembership])

  const resetAccount = useCallback(
    async (plan: ResetPlan[]): Promise<string> => {
      const ms = matrixSessionRef.current
      if (!ms) throw new Error('Not signed in')

      // Workspaces first, key last. If a hand-off fails the user still holds
      // their old key and nothing is lost; rotating first would strand them
      // mid-way with a new key and workspaces they can no longer manage.
      for (const item of plan) {
        const handle = await openRoomForMembership(ms, item.id)
        if (item.action === 'handoff') {
          await handle.setUserRole(item.successor, 'admin')
          await handle.leaveWorkspace(false)
        } else {
          await handle.leaveWorkspace(true)
        }
      }

      // Rotate secret storage to a fresh random key. Everything encrypted under
      // the old key is now unreachable — which is the point.
      const newKey: string = await ms.resetRecovery()

      // Old passkey wraps hold the OLD key, so they are worse than useless:
      // leaving them would let a passkey "unlock" to a key that opens nothing.
      try {
        await saveWrapRecord(ms, emptyWrapRecord())
      } catch (e) {
        console.warn('[reset] could not clear passkey wraps:', e)
      }
      const uid: string | undefined = ms.userId?.()
      if (uid) {
        setAccounts(prev => {
          const updated = prev.map(a =>
            a.userId === uid
              ? { ...a, passkeyWrap: undefined, custody: 'manual' as const, keySaved: false }
              : a,
          )
          saveAccounts(updated)
          return updated
        })
      }
      custodyRef.current = 'manual'
      passkeyEnrolledRef.current = false
      setPasskeyEnrolled(false)
      return newKey
    },
    [openRoomForMembership],
  )

  const resetApp = useCallback(() => {
    // Read the store names BEFORE the wipe: the entries that name them are
    // about to be deleted, and after that the stores are unreachable. "Reset
    // app data" that leaves every account's encrypted history sitting in
    // IndexedDB is not a reset. (issue f6901da6)
    const orphans = loadAccounts()
      .map(a => a.storeName)
      .filter((n): n is string => !!n)

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

    // AFTER the wipe — the queue lives under a `collab:` key, so writing it
    // first would erase it. The reload is what actually collects these: the
    // worker still holds the stores open right now, and a fresh boot is the one
    // moment nothing does.
    orphans.forEach(n => void retireStore(n))

    // Reload the page to get a clean state
    window.location.replace('/signin')
  }, [])

  /** Delete this account for good: the billing Worker cancels any subscription,
   *  then deactivates and erases it. Irreversible.
   *
   *  Local state is cleared only AFTER the server confirms, so a failed attempt
   *  leaves the user signed in and able to retry rather than stranded in a
   *  half-deleted app.
   *
   *  `resetApp` clears the account pool and every `collab:` key, then reloads.
   *  It does NOT drop this device's IndexedDB store — that is issue f6901da6,
   *  and it applies here too: the leftover store is encrypted at rest and its
   *  account no longer exists, but on a shared machine it should still go. */
  const deleteAccount = useCallback(async () => {
    const ms = matrixSessionRef.current
    if (!ms || typeof ms.requestOpenIdToken !== 'function') {
      throw new Error('Please sign in again to delete your account.')
    }
    await requestAccountDeletion(await ms.requestOpenIdToken())
    resetApp()
  }, [resetApp])

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
    deleteAccount,
    listResettableWorkspaces,
    resetAccount,
    recoveryPrompt,
    submitRecoveryKey,
    dismissRecoveryPrompt,
    retryRecoverySetup,
    passkeyAvailable,
    passkeyEnrolled,
    addPasskeySpeedup,
    confirmKeySaved,
    revealLegacyKey,
    markKeySaved,
    unlockWithPasskey,
    unlockSessionWithPasskey,
    submitUnlockKey: unlockAndRestore,
    revealRecoveryKey,
    regenerateRecoveryKey,
    openBillingPortal,
    openCheckout,
    verification,
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
