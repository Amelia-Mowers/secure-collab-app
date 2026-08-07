/**
 * Wire protocol between a tab and the SharedWorker that owns the Matrix client
 * (issue 87bf86a6 — multi-tab writes silently dropped).
 *
 * WHY A WORKER AT ALL. Two tabs of the same account are the SAME Matrix device:
 * `storeName` lives in the session blob, so a second tab restores the same
 * IndexedDB crypto store. The Olm account, its one-time keys and the megolm
 * ratchet have a single writer by design, and the sync stream is likewise
 * single-holder — so the second tab's `initialSync` times out and everything it
 * writes is queued into a client that never gets to send. It reports no error,
 * which is the dangerous part. The fix is to stop making a second client: ONE
 * client lives in a SharedWorker and every tab drives it over a MessagePort.
 *
 * SHAPE OF THE PROTOCOL. Requests are `{ id, kind, … }` and are answered by
 * exactly one `Response` carrying the same id. Everything else the worker sends
 * is an unsolicited `Event` (id-less) broadcast to every connected port —
 * callbacks that used to be JS closures (`startSync`'s on_change,
 * `onQueueChanged`, token refresh) cannot cross a port, so they become events.
 *
 * HANDLES, NOT OBJECTS. WASM objects can't be cloned to a tab, so the worker
 * keeps them in a registry and hands back string keys:
 *
 *   `session:<userId>`   a MatrixSession
 *   `room:<roomId>`      a ConnectedWorkspace (scoped to one session)
 *   `verify:<flowId>`    a DeviceVerification
 *
 * `Call` then invokes a method on a handle by name. That is deliberately
 * generic: the two bridges expose ~60 methods between them and hand-writing a
 * case per method is churn with no added safety — the typed surface tabs
 * actually program against is `workerClient.ts`, and the worker guards the
 * generic path with the allowlists below.
 *
 * WHAT STAYS IN THE TAB. Anything needing a document: WebAuthn/passkey PRF
 * (`navigator.credentials` is unavailable in workers) and the OAuth popup. Those
 * run in the tab as they do today; only their *results* (the master secret, the
 * redirected URL) cross to the worker. localStorage is likewise tab-only, so the
 * tab remains the owner of the persisted account pool — the worker hands back
 * session blobs and the tab writes them.
 */

/** Values that survive `postMessage`'s structured clone in both directions. */
export type Cloneable = string | number | boolean | null | undefined | Uint8Array

/** How a session handle is brought into existence. */
export type SessionVia = 'login' | 'register' | 'restore' | 'finishOauthLogin'

// ── Requests (tab → worker) ──────────────────────────────────────────────────

/** Liveness + build check. A tab whose bundle no longer matches the worker's
 *  (a deploy replaced the assets while the worker stayed alive) must not talk to
 *  it — mismatched glue over one wasm instance is undefined behaviour. */
export interface PingRequest {
  kind: 'ping'
  id: number
  /** The tab's `__BUILD_ID__`. */
  build: string
}

/**
 * Create — or JOIN — the session for an account. The dedupe here is the whole
 * point of the exercise: a second tab restoring the same account gets the
 * client the first tab already built instead of a second one over the same
 * store. `expectUserId` lets that short-circuit happen *before* any client is
 * built (a restore knows the account it is restoring); login/register/OAuth
 * can't know it up front and are deduped after the fact.
 */
export interface SessionCreateRequest {
  kind: 'session.create'
  id: number
  via: SessionVia
  /** MXID this call is expected to yield, when the caller knows it. */
  expectUserId?: string
  /** `via`-specific positional arguments — see `SESSION_FACTORY_ARITY`. */
  args: Cloneable[]
}

/** A static (constructor-level) MatrixSession method, e.g. `startOauthLogin`. */
export interface SessionStaticRequest {
  kind: 'session.static'
  id: number
  method: string
  args: Cloneable[]
}

/** Drop a session (sign-out): stop its loops, forget its workspaces. */
export interface SessionDestroyRequest {
  kind: 'session.destroy'
  id: number
  userId: string
}

/**
 * Open — or join — a ConnectedWorkspace for `roomId` under `userId`, starting
 * its sync loop and queue listener. Deduped per room like sessions are: the
 * second tab to open a workspace attaches to the running one, which is why its
 * writes now reach the server.
 */
export interface WorkspaceOpenRequest {
  kind: 'workspace.open'
  id: number
  userId: string
  roomId: string
  /**
   * At-rest key for the snapshot and outbox stores, or omitted for a v1
   * (plaintext) account.
   *
   * The tab sends the KEY, not the loaded snapshot: the worker owns the send
   * queue, so it must also own the persistence of that queue. Mirroring it from
   * a tab meant reading the queue one hop away from where it changed, which
   * silently persisted a stale (empty) outbox and lost writes across a reload.
   *
   * `CryptoKey` survives structured clone, and a non-extractable one stays
   * non-extractable — the worker gains USE of the key, not the secret. The tab
   * already sends `storePassphrase` for `MatrixSession.restore`, so this crosses
   * no boundary that was not already crossed.
   */
  snapshotKey?: CryptoKey
}

/**
 * Declare which tables this tab is looking at, and start receiving
 * `workspace-state` pushes for the room (option b in the issue: the worker owns
 * truth and PUSHES materialized state, so a tab's reads stay SYNCHRONOUS).
 *
 * Everything cheap — the table list, schemas, views — is pushed whole. ROWS are
 * pushed only for the tables named here, because rows are the only part whose
 * size scales with the data, and a tab reads exactly one table's rows at a time.
 * Re-send this whenever the tab looks at a different table; it replaces the
 * previous subscription.
 */
export interface WorkspaceSubscribeRequest {
  kind: 'workspace.subscribe'
  id: number
  roomId: string
  /** Table ids whose rows this tab needs. Empty = metadata only. */
  tableIds: string[]
}

/** Acquire a handle for an in-flight incoming device verification. */
export interface VerificationAcquireRequest {
  kind: 'verification.acquire'
  id: number
  userId: string
  flowId: string
}

/** Invoke `method` on a handle. Sync and async methods are both awaited, so
 *  every call answers with a Response. */
export interface CallRequest {
  kind: 'call'
  id: number
  /** A handle key: `session:<userId>` | `room:<roomId>` | `verify:<flowId>`. */
  target: string
  method: string
  args: Cloneable[]
}

/** A tab going away (pagehide). Best-effort: the worker also prunes ports whose
 *  `postMessage` throws, since there is no reliable port-close signal. */
export interface ByeRequest {
  kind: 'bye'
}

export type Request =
  | PingRequest
  | SessionCreateRequest
  | SessionStaticRequest
  | SessionDestroyRequest
  | WorkspaceOpenRequest
  | WorkspaceSubscribeRequest
  | VerificationAcquireRequest
  | CallRequest
  | ByeRequest

// ── Responses (worker → the one tab that asked) ──────────────────────────────

export interface OkResponse {
  kind: 'response'
  id: number
  ok: true
  value: Cloneable
}

export interface ErrResponse {
  kind: 'response'
  id: number
  ok: false
  /** Message only — an Error's prototype doesn't survive structured clone, and
   *  callers match on the text (see `lib/authErrors.ts`). */
  error: string
}

export type Response = OkResponse | ErrResponse

/** `session.create` resolves to this (JSON-encoded in `value`). */
export interface SessionInfo {
  userId: string
  /** `sessionData()` — the tab persists it (encrypting it for a v2 account). */
  sessionData: string
  /** True when this call attached to a session another tab had already built.
   *  Diagnostic: it is the observable signature of the fix working. */
  joined: boolean
}

/** `ping` resolves to this. */
export interface PingInfo {
  /** Build id of the bundle that started the worker (the first tab to ping). */
  build: string
  /** Whether tab and worker were built from the same bundle. */
  match: boolean
  /** MXIDs the worker currently holds sessions for. */
  sessions: string[]
}

// ── Events (worker → every tab) ──────────────────────────────────────────────

/** A workspace's materialized state changed because remote events landed. The
 *  payload is deliberately data-free, exactly like the BroadcastChannel ping it
 *  replaces: plaintext must not be duplicated into contexts that did not
 *  already hold it. Tabs re-read through their own read model. */
export interface WorkspaceChangeEvent {
  kind: 'event'
  event: 'workspace-change'
  roomId: string
}

/**
 * A workspace's materialized state, as read out of the worker's single
 * ConnectedWorkspace. This is what lets a tab keep answering reads
 * synchronously without owning a client: it holds the last pushed bundle and
 * reads out of it.
 *
 * Every field is the exact JSON the corresponding bridge method returns, kept as
 * a string rather than parsed here — the callers already `JSON.parse` these, and
 * re-encoding parsed objects would only add a place for the shapes to drift.
 *
 * Unlike `workspace-change` this DOES carry plaintext, so it goes only to the
 * ports that asked for it — tabs of the same account in the same origin, which
 * already hold this data today. It is never broadcast.
 */
export interface WorkspaceState {
  /** `listTables()` */
  tables: string
  /** `getTableOrderKeys()` */
  tableOrderKeys: string
  /** `currentUserId()` — what an `@me` filter resolves to. */
  currentUserId?: string
  /** `isEncrypted()` */
  isEncrypted: boolean
  /** `undecryptableCount()` */
  undecryptableCount: number
  /** `connectionHealth()` */
  connectionHealth: string
  /** `rejectedWrites()` */
  rejectedWrites: string
  /** `pendingUpdates()` */
  pendingUpdates: string
  /** `getTableSchema(id)` for every table. */
  schemas: Record<string, string>
  /** `listViewsForTable(id)` for every table. */
  viewsByTable: Record<string, string>
  /** `getView(id)` for every view of every table — small, and a tab can ask for
   *  a view whose table it is not currently subscribed to. */
  views: Record<string, string>
  /** `getTableRows(id)` for SUBSCRIBED tables only. */
  rows: Record<string, string>
  /** `getRowOrderKeys(id)` for SUBSCRIBED tables only. */
  rowOrderKeys: Record<string, string>
}

/** A fresh materialized bundle for one room, sent to a subscribed port. */
export interface WorkspaceStateEvent {
  kind: 'event'
  event: 'workspace-state'
  roomId: string
  /** A JSON-encoded `WorkspaceState`. */
  state: string
}

/** A workspace's unsent send queue changed — drives the outbox mirror. */
export interface QueueChangeEvent {
  kind: 'event'
  event: 'queue-change'
  roomId: string
}

/** The session-level sync saw the room list change (invites, joins, leaves). */
export interface SessionSyncEvent {
  kind: 'event'
  event: 'session-sync'
  userId: string
}

/** The SDK refreshed its tokens. The tab re-persists the blob — MAS access
 *  tokens are short-lived and a reload would otherwise restore a dead one. */
export interface TokenRefreshEvent {
  kind: 'event'
  event: 'token-refresh'
  userId: string
  sessionData: string
}

/** A session was destroyed (sign-out in some tab). Sibling tabs holding that
 *  account must drop their handles rather than call into a dead session. */
export interface SessionDroppedEvent {
  kind: 'event'
  event: 'session-dropped'
  userId: string
}

/** Worker-side diagnostics, re-logged in the tab. A SharedWorker's console is
 *  not the tab's, and neither Playwright nor a bug report can reach it — so
 *  anything worth reading is forwarded rather than lost. */
export interface LogEvent {
  kind: 'event'
  event: 'log'
  level: 'log' | 'warn' | 'error'
  message: string
}

export type Event =
  | WorkspaceChangeEvent
  | WorkspaceStateEvent
  | QueueChangeEvent
  | SessionSyncEvent
  | TokenRefreshEvent
  | SessionDroppedEvent
  | LogEvent

export type Message = Response | Event

// ── Method allowlists ────────────────────────────────────────────────────────
//
// `call` invokes a method by name, so the set of names is pinned here rather
// than left to whatever the bridge happens to expose. The worker is same-origin
// with the tab, so this is not a trust boundary — it is a spelling check: a
// typo'd or renamed method fails loudly with "not callable" instead of
// resolving to `undefined` and looking like a null result.

/** Methods callable on `session:<userId>`. */
export const SESSION_METHODS = new Set([
  // identity / profile
  'userId', 'getDisplayName', 'setDisplayName', 'sessionData',
  // rooms
  'listRooms', 'listInvitedRooms', 'createRoom', 'joinRoom', 'declineInvite',
  // sync
  'initialSync',
  // recovery / secure backup
  'recoveryStatus', 'recoveryUsesPassphrase', 'enableRecovery',
  'enableRecoveryWithPassphrase', 'resetRecovery', 'resetRecoveryWithPassphrase',
  'recoverWithKey',
  // billing
  'requestOpenIdToken',
  // account data — the passkey wrap lives here (issue 63dc1339)
  'getAccountData', 'setAccountData',
  // device verification (incoming)
  'startVerificationListener', 'pendingVerificationFlow',
])

/** Static MatrixSession methods callable via `session.static`. */
export const SESSION_STATIC_METHODS = new Set([
  'homeserverSupportsOauth',
  'startOauthLogin',
])

/** Methods callable on `room:<roomId>`. */
export const WORKSPACE_METHODS = new Set([
  // reads (the read model answers these locally once staged; kept callable so
  // the worker stays the authority a tab can always fall back to)
  'getTableRows', 'getRowOrderKeys', 'getTableSchema', 'getView', 'listTables',
  'listViewsForTable', 'getTableOrderKeys', 'currentUserId', 'snapshot',
  'isEncrypted', 'undecryptableCount', 'connectionHealth', 'rejectedWrites',
  'keyBackupCaughtUp', 'flushKeyBackup', 'retryUndecryptable',
  'pendingUpdates', 'exportTableCsv', 'exportWorkspaceZip', 'previewCsvImport',
  // writes
  'createTable', 'renameTable', 'deleteTable', 'setTableOrder',
  'createView', 'deleteView',
  'addColumn', 'updateColumn', 'deleteColumn', 'reorderColumns',
  'setColumnWidth',
  'updateCell', 'deleteRow', 'applyUpdate', 'importCsv', 'importWorkspaceZip',
  'importWorkspaceArchive',
  'restorePendingUpdates',
  // membership / roles
  'inviteUser', 'listMembers', 'myRole', 'setUserRole', 'leaveWorkspace',
  // history
  'getChangeLog', 'rollbackTo', 'checkIntegrity',
])

/**
 * Workspace methods that CHANGE materialized state. After one of these the
 * worker re-pushes state to every subscribed port, so a sibling tab sees the
 * write immediately instead of waiting for the sync echo to come back from the
 * homeserver (or, as today, for the user to switch back to that tab).
 *
 * Being wrong here is a stale grid, not corruption, and the sync echo repairs it
 * within a round-trip — but a missing entry is still a bug, so any method added
 * to `WORKSPACE_METHODS` that mutates belongs here too.
 */
export const WORKSPACE_WRITE_METHODS = new Set([
  'createTable', 'renameTable', 'deleteTable', 'setTableOrder',
  'createView', 'deleteView',
  'addColumn', 'updateColumn', 'deleteColumn', 'reorderColumns', 'setColumnWidth',
  'updateCell', 'deleteRow', 'applyUpdate', 'importCsv', 'importWorkspaceZip',
  'importWorkspaceArchive',
  'restorePendingUpdates', 'rollbackTo', 'checkIntegrity',
  // Applies the updates from events that have just become decryptable, so the
  // grid must be re-pushed — the whole point is that data appears.
  'retryUndecryptable',
])

/** Methods callable on `verify:<flowId>`. */
export const VERIFICATION_METHODS = new Set([
  'flowId', 'accept', 'emoji', 'confirm', 'cancel', 'isDone', 'advance', 'state',
])

/**
 * Positional arguments each session factory takes, so the worker can validate
 * an incoming `session.create` instead of splatting whatever arrived into a
 * wasm constructor.
 *
 *   login             (homeserver, user, password, storePassphrase?)
 *   register          (homeserver, user, password, storePassphrase?, registrationToken?)
 *   restore           (homeserver, sessionData, storePassphrase?)
 *   finishOauthLogin  (redirectedUrl)
 */
export const SESSION_FACTORY_ARITY: Record<SessionVia, { min: number; max: number }> = {
  login: { min: 3, max: 4 },
  // 5 args: a homeserver with `registration_requires_token` needs an invitation
  // token as the last one.
  register: { min: 3, max: 5 },
  restore: { min: 2, max: 3 },
  finishOauthLogin: { min: 1, max: 1 },
}

/** Handle-key helpers — one spelling, used by both sides. */
export const sessionKey = (userId: string) => `session:${userId}`
export const roomKey = (roomId: string) => `room:${roomId}`
export const verifyKey = (flowId: string) => `verify:${flowId}`
