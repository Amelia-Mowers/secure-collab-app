import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { openOauthPopup, OAUTH_CALLBACK_MESSAGE } from './oauthPopup'

describe('openOauthPopup', () => {
  let fakePopup: { location: { href: string }; closed: boolean; close: () => void }

  beforeEach(() => {
    vi.useFakeTimers()
    fakePopup = { location: { href: '' }, closed: false, close: vi.fn(() => undefined) }
    vi.spyOn(window, 'open').mockReturnValue(fakePopup as unknown as Window)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns null when the browser blocks the popup', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openOauthPopup()).toBeNull()
  })

  it('navigates the popup to the authorization URL', () => {
    const popup = openOauthPopup()!
    popup.navigate('https://mas.example/authorize?x=1')
    expect(fakePopup.location.href).toBe('https://mas.example/authorize?x=1')
  })

  it('resolves with the callback URL posted from our origin', async () => {
    const popup = openOauthPopup()!
    const result = popup.waitForCallback()

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: OAUTH_CALLBACK_MESSAGE, url: 'http://app/oauth/callback?code=abc' },
      }),
    )

    await expect(result).resolves.toBe('http://app/oauth/callback?code=abc')
  })

  it('ignores messages from other origins (the popup navigates to MAS)', async () => {
    const popup = openOauthPopup()!
    const result = popup.waitForCallback()

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example',
        data: { type: OAUTH_CALLBACK_MESSAGE, url: 'http://evil/steal' },
      }),
    )
    // Still pending — resolve it properly afterwards to finish the test.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: OAUTH_CALLBACK_MESSAGE, url: 'http://app/oauth/callback?code=real' },
      }),
    )

    await expect(result).resolves.toBe('http://app/oauth/callback?code=real')
  })

  it('rejects when the user closes the popup', async () => {
    const popup = openOauthPopup()!
    const result = popup.waitForCallback()
    result.catch(() => {}) // attach early so the rejection is never unhandled

    fakePopup.closed = true
    await vi.advanceTimersByTimeAsync(600)

    await expect(result).rejects.toThrow(/cancelled/i)
  })

  it('rejects and closes the popup on timeout', async () => {
    const popup = openOauthPopup()!
    const result = popup.waitForCallback()
    result.catch(() => {})

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000)

    await expect(result).rejects.toThrow(/timed out/i)
    expect(fakePopup.close).toHaveBeenCalled()
  })
})
