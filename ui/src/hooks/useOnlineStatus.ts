import { useSyncExternalStore } from 'react'

/**
 * Tracks browser connectivity via `navigator.onLine` and the window
 * `online`/`offline` events. This is a coarse signal — it reflects whether the
 * device has a network interface, not whether the homeserver is reachable — but
 * it has effectively no false positives and clears automatically on reconnect,
 * which makes it a safe basis for an interim "you're offline" guard (until a
 * real offline mode exists).
 */
function subscribe(callback: () => void): () => void {
  window.addEventListener('online', callback)
  window.addEventListener('offline', callback)
  return () => {
    window.removeEventListener('online', callback)
    window.removeEventListener('offline', callback)
  }
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true, // assume online when there is no browser (SSR / tests)
  )
}
