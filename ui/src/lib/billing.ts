import { BILLING_DELETE_ACCOUNT_URL, BILLING_PORTAL_URL } from '@/branding'

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

/**
 * Delete the signed-in account: the Worker cancels any subscription, then
 * deactivates and erases it. Same OpenID-token proof as the portal.
 *
 * The errors are distinguished because they mean different things to a user
 * mid-deletion: `cancel_failed` means nothing happened and it is safe to retry;
 * `deactivate_failed` means the subscription IS already cancelled, so they are
 * not still being charged while they try again.
 */
export async function requestAccountDeletion(openIdTokenJson: string): Promise<void> {
  const res = await fetch(BILLING_DELETE_ACCOUNT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: openIdTokenJson,
  })
  if (res.ok) return

  const code = await res
    .json()
    .then((b: { error?: string }) => b?.error)
    .catch(() => undefined)
  if (code === 'no_account') throw new Error('This account no longer exists.')
  if (code === 'cancel_failed') {
    throw new Error(
      'Could not cancel your subscription, so nothing was deleted. Please try again.',
    )
  }
  if (code === 'deactivate_failed') {
    throw new Error(
      'Your subscription was cancelled, but the account could not be deleted. ' +
        'You are not being charged. Please try again.',
    )
  }
  throw new Error('Could not delete the account. Please try again.')
}
