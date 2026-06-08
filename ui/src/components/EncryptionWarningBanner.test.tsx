import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EncryptionWarningBanner } from './EncryptionWarningBanner'

describe('EncryptionWarningBanner', () => {
  it('warns when there are undecryptable items', () => {
    render(<EncryptionWarningBanner workspace={{ undecryptableCount: () => 3 }} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/3 items/)
    expect(alert.textContent).toMatch(/couldn.t be decrypted/i)
  })

  it('uses singular wording for a single item', () => {
    render(<EncryptionWarningBanner workspace={{ undecryptableCount: () => 1 }} />)
    expect(screen.getByRole('alert').textContent).toMatch(/1 item /)
  })

  it('renders nothing when the count is zero', () => {
    const { container } = render(
      <EncryptionWarningBanner workspace={{ undecryptableCount: () => 0 }} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for a workspace without undecryptableCount (local / mock)', () => {
    const { container } = render(<EncryptionWarningBanner workspace={{}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
