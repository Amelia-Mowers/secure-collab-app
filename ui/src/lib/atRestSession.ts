/**
 * Session-scoped at-rest snapshot key (issue c72ec5df).
 *
 * The at-rest keys are derived in `useAuth` at unlock and held in a ref there.
 * `useWorkspace` (a separate hook) needs the snapshot key to encrypt/decrypt the
 * workspace snapshot, but threading a non-serializable `CryptoKey` through React
 * context + props is invasive and would break the mock-based useTable tests. So
 * `useAuth` publishes the key here imperatively on unlock, and `useWorkspace`
 * reads it. Null before unlock / for legacy (v1) sessions → snapshots fall back
 * to plaintext, exactly as before. Never persisted.
 */
let snapshotKey: CryptoKey | null = null

/** Called by useAuth once the master secret is unlocked (or cleared on sign-out). */
export function setSnapshotKey(key: CryptoKey | null): void {
  snapshotKey = key
}

/** Read by useWorkspace at snapshot save/load; null = plaintext fallback. */
export function getSnapshotKey(): CryptoKey | null {
  return snapshotKey
}
