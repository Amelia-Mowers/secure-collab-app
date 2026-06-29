import { useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '@/hooks/useAuth'

/**
 * Opens the Stripe billing portal (manage payment methods, invoices, CANCEL).
 * Shared across the verify gate, the trial gate, and the account menu so a user
 * can manage billing even while their E2E is locked (issue row_1782751521723).
 * Redirects on success; surfaces an inline error otherwise. `className` styles
 * the button to match its host; `errorClassName` styles the error line.
 */
export function ManageSubscriptionButton({
  className,
  errorClassName,
  children = 'Manage subscription',
}: {
  className: string
  errorClassName?: string
  children?: ReactNode
}) {
  const { openBillingPortal } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onClick = async () => {
    setError(null)
    setBusy(true)
    try {
      await openBillingPortal() // navigates to Stripe on success
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className={className} onClick={onClick} disabled={busy}>
        {busy ? 'Opening…' : children}
      </button>
      {error && (
        <p className={errorClassName} role="alert">
          {error}
        </p>
      )}
    </>
  )
}
