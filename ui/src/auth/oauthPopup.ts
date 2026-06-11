/**
 * Popup orchestration for the OAuth (next-gen auth / MAS) sign-in flow.
 *
 * The popup architecture is load-bearing, not cosmetic: the PKCE verifier
 * lives inside the in-memory WASM client between `startOauthLogin` and
 * `finishOauthLogin`, so the main page (and its WASM instance) must stay
 * alive while the user authorizes — a full-page redirect would destroy it
 * mid-flow (see ADR 0002 phase A).
 *
 * Flow: open the popup *synchronously* in the click handler (popup blockers
 * only allow window.open during user activation), navigate it to the
 * authorization URL once known, and wait for the callback page
 * (`/oauth/callback`, rendered by OauthCallbackPage) to post the final
 * redirect URL back via postMessage.
 */

export interface OauthPopup {
  /** Navigate the already-open popup to the authorization URL. */
  navigate(url: string): void
  /** Resolve with the callback URL (carrying code+state), or reject if the
   *  user closes the popup / nothing arrives in time. */
  waitForCallback(): Promise<string>
  /** Close the popup (cleanup on error paths). */
  close(): void
}

export const OAUTH_CALLBACK_MESSAGE = 'sc-oauth-callback'

/** Must be called synchronously from a click handler. Returns null if the
 *  browser blocked the popup. */
export function openOauthPopup(timeoutMs = 5 * 60_000): OauthPopup | null {
  const popup = window.open('', 'sc-oauth', 'popup,width=480,height=720')
  if (!popup) return null

  return {
    navigate(url: string) {
      popup.location.href = url
    },

    waitForCallback(): Promise<string> {
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          window.removeEventListener('message', onMessage)
          clearInterval(closedPoll)
          clearTimeout(timer)
        }
        const onMessage = (event: MessageEvent) => {
          if (event.origin !== window.location.origin) return
          if (event.data?.type !== OAUTH_CALLBACK_MESSAGE) return
          cleanup()
          resolve(event.data.url as string)
        }
        // The popup navigates cross-origin (to MAS), so `closed` polling is
        // the only reliable cancel signal.
        const closedPoll = setInterval(() => {
          if (popup.closed) {
            cleanup()
            reject(new Error('Sign-in was cancelled'))
          }
        }, 500)
        const timer = setTimeout(() => {
          cleanup()
          popup.close()
          reject(new Error('Sign-in timed out'))
        }, timeoutMs)
        window.addEventListener('message', onMessage)
      })
    },

    close() {
      popup.close()
    },
  }
}
