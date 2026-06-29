import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { fetchPortalUrl } from './billing'

describe('fetchPortalUrl', () => {
  let fetchMock: Mock

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs the OpenID token and returns the portal url', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ url: 'https://billing.stripe/x' }) })
    const url = await fetchPortalUrl('{"access_token":"t","matrix_server_name":"tidework.io"}')
    expect(url).toBe('https://billing.stripe/x')
    const [calledUrl, opts] = fetchMock.mock.calls[0]
    expect(String(calledUrl)).toContain('/portal')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/json')
    expect(opts.body).toContain('access_token')
  })

  it('maps no_subscription to a friendly message', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'no_subscription' }) })
    await expect(fetchPortalUrl('{}')).rejects.toThrow(/subscription to manage/i)
  })

  it('falls back to a generic error on other failures', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'verification_failed' }) })
    await expect(fetchPortalUrl('{}')).rejects.toThrow(/billing portal/i)
  })

  it('errors when the response carries no url', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
    await expect(fetchPortalUrl('{}')).rejects.toThrow(/billing portal/i)
  })
})
