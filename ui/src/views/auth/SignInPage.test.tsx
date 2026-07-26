import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SignInPage } from './SignInPage'

/**
 * The hosted server delegates auth to MAS, so it has no password login at all.
 * The page used to treat "haven't probed yet" as "password server", which meant
 * the credentials form rendered first and was swapped for the SSO button a
 * moment later — a visible flicker on the most common path, and a form that
 * could never have worked.
 */

const checkOauthSupport = vi.fn()

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithOauth: vi.fn(),
    checkOauthSupport,
    switchAccount: vi.fn(),
    loading: false,
    error: null,
    accounts: [],
  }),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <SignInPage />
    </MemoryRouter>,
  )
}

/** Select the hosted (suggested) server.
 *
 *  Not the default in a dev/self-host build — there `VITE_DEFAULT_HOMESERVER`
 *  is unset and the default is a local Conduit, where a password form is
 *  genuinely right. The flicker this fixes is specific to the hosted build,
 *  whose default IS the MAS-backed server. */
function selectHostedServer() {
  fireEvent.click(screen.getByRole('button', { name: /TideWork/ }))
}

/** The credentials form, identified by its password field. */
const passwordField = () => screen.queryByLabelText(/password/i) ?? screen.queryByPlaceholderText(/password/i)

describe('SignInPage', () => {
  beforeEach(() => {
    checkOauthSupport.mockReset()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  it('shows secure sign-in for the hosted server without flashing a password form', async () => {
    // Never resolves: the probe is still in flight, which is exactly the
    // window the old code filled with a password form.
    checkOauthSupport.mockReturnValue(new Promise(() => {}))
    renderPage()
    selectHostedServer()

    expect(screen.getByTestId('oauth-signin')).toBeInTheDocument()
    expect(passwordField()).toBeNull()
  })

  it('warns instead of offering a password form when MAS is unreachable', async () => {
    checkOauthSupport.mockResolvedValue(false)
    renderPage()
    selectHostedServer()

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/reach the sign-in service/i), {
      timeout: 5_000,
    })
    // Still SSO — the hosted server has no password login to fall back to, so
    // offering one would just fail confusingly.
    expect(screen.getByTestId('oauth-signin')).toBeInTheDocument()
    expect(passwordField()).toBeNull()
  })

  it('offers the password form for a custom server that is not MAS', async () => {
    checkOauthSupport.mockResolvedValue(false)
    renderPage()

    fireEvent.click(screen.getByText('Custom server'))
    fireEvent.change(screen.getByPlaceholderText('https://matrix.example.com'), {
      target: { value: 'https://matrix.example.org' },
    })

    await waitFor(() => expect(passwordField()).not.toBeNull(), { timeout: 5_000 })
    expect(screen.queryByTestId('oauth-signin')).toBeNull()
  })

  it('offers secure sign-in for a custom server that does use MAS', async () => {
    checkOauthSupport.mockResolvedValue(true)
    renderPage()

    fireEvent.click(screen.getByText('Custom server'))
    fireEvent.change(screen.getByPlaceholderText('https://matrix.example.com'), {
      target: { value: 'https://mas.example.org' },
    })

    await waitFor(() => expect(screen.getByTestId('oauth-signin')).toBeInTheDocument(), {
      timeout: 5_000,
    })
  })
})
