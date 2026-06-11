import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OauthCallbackPage } from './OauthCallbackPage'
import { OAUTH_CALLBACK_MESSAGE } from '@/auth/oauthPopup'

describe('OauthCallbackPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    Object.assign(window, { opener: null })
  })

  it('posts the redirect URL to the opener and closes itself', () => {
    const postMessage = vi.fn()
    Object.assign(window, { opener: { postMessage } })
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)

    render(<OauthCallbackPage />)

    expect(postMessage).toHaveBeenCalledWith(
      { type: OAUTH_CALLBACK_MESSAGE, url: window.location.href },
      window.location.origin,
    )
    expect(close).toHaveBeenCalled()
  })

  it('renders a fallback message and survives having no opener', () => {
    Object.assign(window, { opener: null })
    vi.spyOn(window, 'close').mockImplementation(() => undefined)

    render(<OauthCallbackPage />)

    expect(screen.getByText(/signing you in/i)).toBeInTheDocument()
  })
})
