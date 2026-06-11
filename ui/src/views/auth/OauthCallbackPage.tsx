import { useEffect } from 'react'
import { OAUTH_CALLBACK_MESSAGE } from '@/auth/oauthPopup'

/**
 * The OAuth redirect target (`/oauth/callback`), loaded inside the sign-in
 * popup after the user authorizes on the MAS hosted pages. Its only job is to
 * hand the full redirect URL (carrying code+state) back to the opener — the
 * page that holds the WASM client with the PKCE verifier — and close.
 */
export function OauthCallbackPage() {
  useEffect(() => {
    window.opener?.postMessage(
      { type: OAUTH_CALLBACK_MESSAGE, url: window.location.href },
      window.location.origin,
    )
    window.close()
  }, [])

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <p>Signing you in… you can close this window.</p>
    </div>
  )
}
