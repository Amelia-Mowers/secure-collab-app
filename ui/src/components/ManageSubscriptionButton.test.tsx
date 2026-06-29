import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({ openBillingPortal: vi.fn(async () => undefined) }))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ openBillingPortal: h.openBillingPortal }),
}))

import { ManageSubscriptionButton } from './ManageSubscriptionButton'

describe('ManageSubscriptionButton', () => {
  beforeEach(() => {
    h.openBillingPortal = vi.fn(async () => undefined)
  })

  it('opens the billing portal on click', async () => {
    render(<ManageSubscriptionButton className="x" />)
    fireEvent.click(screen.getByRole('button', { name: /manage subscription/i }))
    await waitFor(() => expect(h.openBillingPortal).toHaveBeenCalledTimes(1))
  })

  it('surfaces an error in place (no navigation)', async () => {
    h.openBillingPortal = vi.fn(async (): Promise<undefined> => {
      throw new Error("You don't have a subscription to manage yet.")
    })
    render(<ManageSubscriptionButton className="x" errorClassName="err" />)
    fireEvent.click(screen.getByRole('button', { name: /manage subscription/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/subscription to manage/i))
  })

  it('renders a custom label', () => {
    render(<ManageSubscriptionButton className="x">Billing</ManageSubscriptionButton>)
    expect(screen.getByRole('button', { name: /billing/i })).toBeInTheDocument()
  })
})
