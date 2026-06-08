import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { UnverifiedDevicesBanner } from './UnverifiedDevicesBanner'

describe('UnverifiedDevicesBanner', () => {
  it('warns when there are unverified devices', async () => {
    render(<UnverifiedDevicesBanner workspace={{ unverifiedDeviceCount: () => Promise.resolve(2) }} />)
    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/2 unverified devices/i)
    expect(status.textContent).toMatch(/identity hasn.t been confirmed/i)
  })

  it('uses singular wording for a single device', async () => {
    render(<UnverifiedDevicesBanner workspace={{ unverifiedDeviceCount: () => Promise.resolve(1) }} />)
    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/1 unverified device\b/i)
  })

  it('renders nothing when the count is zero', async () => {
    const { container } = render(
      <UnverifiedDevicesBanner workspace={{ unverifiedDeviceCount: () => Promise.resolve(0) }} />,
    )
    // Give the async effect a tick; banner should stay empty.
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('renders nothing for a workspace without the method (local / mock)', () => {
    const { container } = render(<UnverifiedDevicesBanner workspace={{}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
