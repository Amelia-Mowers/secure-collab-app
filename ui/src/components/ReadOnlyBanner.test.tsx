import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReadOnlyBanner } from './ReadOnlyBanner'

describe('ReadOnlyBanner', () => {
  it('shows the read-only notice when the room is not encrypted', () => {
    render(<ReadOnlyBanner workspace={{ isEncrypted: () => false }} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/read-only/i)
    expect(alert.textContent).toMatch(/end-to-end encrypted/i)
  })

  it('renders nothing for an encrypted room', () => {
    const { container } = render(<ReadOnlyBanner workspace={{ isEncrypted: () => true }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for a workspace without isEncrypted (local / mock)', () => {
    const { container } = render(<ReadOnlyBanner workspace={{}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
