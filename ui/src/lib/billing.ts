import { BILLING_PORTAL_URL } from '@/branding'

/**
 * Exchange a Matrix OpenID token (the JSON string from the bridge's
 * `requestOpenIdToken`) for a Stripe billing-portal URL at the billing Worker.
 * The Worker verifies the token against the homeserver before returning a URL,
 * so this proves identity without exposing the access token. Throws a
 * user-facing message on failure. (issue row_1782751521723)
 */
export async function fetchPortalUrl(openIdTokenJson: string): Promise<string> {
  const res = await fetch(BILLING_PORTAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: openIdTokenJson,
  })
  if (!res.ok) {
    const code = await res
      .json()
      .then((b: { error?: string }) => b?.error)
      .catch(() => undefined)
    throw new Error(
      code === 'no_subscription'
        ? "You don't have a subscription to manage yet."
        : 'Could not open the billing portal. Please try again.',
    )
  }
  const { url } = (await res.json()) as { url?: string }
  if (!url) throw new Error('Could not open the billing portal. Please try again.')
  return url
}
